"""Multi-Expense / Multi-Revenue extension for Payment Entry.

Activated via ``extend_doctype_class`` in hooks.py (not
``override_doctype_class``): Frappe builds the controller as
(MultiPaymentEntryMixin, <winning class>), so this always runs and every
``super()`` call falls through to hrms's EmployeePaymentEntry or plain
ERPNext's PaymentEntry for anything that is not multi mode.

When ``multi_expense`` is ticked:
- Party is hidden and becomes optional.
- A child table (Payment Entry Expense Account) holds the real lines:
    Pay     -> every line posts Debit  (expense).
    Receive -> every line posts Credit (income).
- The bank side is the total of all table rows.
- Line amounts are in the bank account's currency and are converted to
  company currency with the bank rate (source rate for Pay, target rate
  for Receive), exactly like a normal Payment Entry's bank line.
"""

import frappe
from erpnext.accounts.doctype.payment_entry.payment_entry import get_account_details
from erpnext.accounts.general_ledger import make_gl_entries, process_gl_map
from erpnext import get_company_currency
from erpnext.accounts.utils import cancel_exchange_gain_loss_journal, get_account_currency
from erpnext.setup.utils import get_exchange_rate
from frappe import _
from frappe.utils import cint, flt


class MultiPaymentEntryMixin:
    """Adds multi-expense / multi-revenue support to Payment Entry.

    A mixin, not a full controller replacement - has no base class of its
    own. Frappe's extend_doctype_class machinery places it first in the
    MRO ahead of whichever class actually controls Payment Entry on a
    given site, so every ``super()`` call below resolves correctly to
    that class regardless of which app it belongs to.
    """

    # ---------------------------------------------------------------
    # helpers
    # ---------------------------------------------------------------

    def is_multi_expense(self):
        return cint(self.get("multi_expense")) == 1

    # ---------------------------------------------------------------
    # validate
    # ---------------------------------------------------------------

    def set_missing_values(self):
        """Skip party-related lookups when multi-expense is active."""
        if self.payment_type == "Internal Transfer" or not self.is_multi_expense():
            super().set_missing_values()
            return
        self._set_payment_account_details()
        self._set_party_account_currency()

    def validate_mandatory(self):
        """Skip party account checks in multi-expense mode."""
        if not self.is_multi_expense():
            super().validate_mandatory()
            return
        for field in ("paid_amount", "received_amount",):
            if not self.get(field):
                frappe.throw(_("{0} is mandatory").format(_(self.meta.get_label(field))))

    def validate(self):
        """Override to skip upstream party validations in multi mode."""
        if self.is_multi_expense():
            self.setup_party_account_field()
            self.set_missing_values()
            self._validate_line_currencies()
            self.set_liability_account()
            self.set_missing_ref_details(force=True)
            self.validate_payment_type()
            self._set_multi_exchange_rate()
            self.set_amounts()
            self._validate_mandatory_fields()
            self.validate_amounts()
            self.apply_taxes()
            self.set_amounts_after_tax()
            self.clear_unallocated_reference_document_rows()
            # Transaction reference is not required in multi mode (no party)
            if not self.get("reference_no"):
                self.reference_no = "Multi-Expense"
                self.reference_date = self.posting_date
            self.validate_transaction_reference()
            self.set_title()
            self.set_remarks()
            self.validate_duplicate_entry()
            self.validate_payment_type_with_outstanding()
            self.validate_allocated_amount()
            self.validate_paid_invoices()
            self.ensure_supplier_is_not_blocked()
            from erpnext.accounts.doctype.tax_withholding_entry.tax_withholding_entry import PaymentTaxWithholding
            PaymentTaxWithholding(self).on_validate()
            self._validate_no_taxes_or_deductions()
            self.set_status()
            self.set_total_in_words()
        else:
            super().validate()

    def on_submit(self):
        if self.is_multi_expense():
            self.update_payment_requests()
            self.update_payment_schedule()
            self.make_gl_entries()
            self.update_outstanding_amounts()
            self.set_status()
        else:
            super().on_submit()

    # ---------------------------------------------------------------
    # account lookups (multi-mode, no party)
    # ---------------------------------------------------------------

    def _set_payment_account_details(self):
        if self.paid_from and (not self.paid_from_account_currency or not self.paid_from_account_type):
            acc = get_account_details(self.paid_from, self.posting_date, self.cost_center)
            self.paid_from_account_currency = acc.account_currency
            self.paid_from_account_balance = acc.account_balance
            self.paid_from_account_type = acc.account_type

        if self.paid_to and (not self.paid_to_account_currency or not self.paid_to_account_type):
            acc = get_account_details(self.paid_to, self.posting_date, self.cost_center)
            self.paid_to_account_currency = acc.account_currency
            self.paid_to_account_balance = acc.account_balance
            self.paid_to_account_type = acc.account_type

        # The opposite side has no account in multi mode: mirror the bank side so
        # both currencies match (set_transaction_currency_and_rate reads both).
        if self.is_multi_expense() and self.payment_type == "Pay":
            self.paid_to_account_currency = self.paid_to_account_currency or self.paid_from_account_currency
            self.paid_to_account_type = self.paid_to_account_type or self.paid_from_account_type
        if self.is_multi_expense() and self.payment_type == "Receive":
            self.paid_from_account_currency = self.paid_from_account_currency or self.paid_to_account_currency
            self.paid_from_account_type = self.paid_from_account_type or self.paid_to_account_type

    def _set_party_account_currency(self):
        if self.is_multi_expense():
            # No party in multi mode — use the BANK side currency so that
            # set_exchange_rate() can resolve source/target rates (paid_from
            # is empty for multi Receive and must not be looked up).
            self.party_account_currency = (
                self.paid_from_account_currency if self.payment_type == "Pay"
                else self.paid_to_account_currency
            )
            return
        self.party_account_currency = (
            self.paid_from_account_currency if self.payment_type == "Receive"
            else self.paid_to_account_currency
        )

    def _validate_mandatory_fields(self):
        if not self.get("expense_items"):
            frappe.throw(
                _("Please add at least one line to the Expenses/Revenues table before saving.")
            )
        for field in ("paid_amount", "received_amount"):
            if not self.get(field):
                frappe.throw(_("{0} is mandatory").format(_(self.meta.get_label(field))))

    def _get_missing_mandatory_fields(self):
        """Override Frappe's meta-level mandatory check for multi mode.

        Frappe runs _validate_mandatory() AFTER the validate() hook and checks
        every field with reqd=1 in the DocType meta — regardless of any
        runtime (JS-side) relaxation. In multi mode the opposite-side account
        is intentionally left empty (paid_to for Pay / paid_from for Receive),
        so filter it out here; every other reqd field (amounts, rates,
        currencies) is auto-populated by our validate() chain before this runs.
        """
        missing = super()._get_missing_mandatory_fields()
        if not self.is_multi_expense():
            return missing

        # paid_amount / received_amount are auto-derived from the child table
        # in multi mode, so they must not be flagged as missing either.
        skip = {"paid_amount", "received_amount"}
        if self.payment_type == "Pay":
            skip.update([
                "paid_to",
                "paid_to_account_currency",
                "target_exchange_rate",
            ])
        elif self.payment_type == "Receive":
            skip.update([
                "paid_from",
                "paid_from_account_currency",
                "source_exchange_rate",
            ])

        return [item for item in missing if item[0] not in skip]

    # ---------------------------------------------------------------
    # GL mapping (multi mode)
    # ---------------------------------------------------------------

    def build_gl_map(self):
        if not self.is_multi_expense():
            return super().build_gl_map()
        if self.payment_type in ("Receive", "Pay") and not self.get("party_account_field"):
            self.setup_party_account_field()
        self.set_transaction_currency_and_rate()

        gl_entries = []
        self.make_expense_gl_entries(gl_entries)
        self.add_bank_gl_entries(gl_entries)
        self.set_transaction_currency_and_rate_in_gl_map(gl_entries)
        return gl_entries

    def make_expense_gl_entries(self, gl_entries):
        """Post child-table lines as Debit (Pay) or Credit (Receive)."""
        if not self.is_multi_expense() or not self.get("expense_items"):
            return

        company_currency = get_company_currency(self.company)
        for line in self.expense_items:
            if not flt(line.amount):
                continue
            account_currency = get_account_currency(line.account)
            base = self._line_base_amount(line)
            # company-currency account -> converted value; bank-currency account -> line value
            in_account = base if account_currency == company_currency else flt(line.amount)

            gl_row = {
                "account": line.account,
                "account_currency": account_currency,
                "cost_center": line.cost_center or self.cost_center,
                "project": line.get("project") or self.get("project"),
                "party_type": line.party_type or None,
                "party": line.party or None,
                "remarks": line.remarks or None,
            }
            dr_cr = "debit" if self.payment_type == "Pay" else "credit"
            gl_row[dr_cr] = base
            gl_row[f"{dr_cr}_in_account_currency"] = in_account
            gl_row[f"{dr_cr}_in_transaction_currency"] = flt(line.amount)
            # item=line: accounting dimensions come from the line, then from the payment
            gl_entries.append(self.get_gl_dict(gl_row, item=line))

    def add_bank_gl_entries(self, gl_entries):
        if self.is_multi_expense():
            if self.payment_type == "Pay":
                self._add_multi_pay_bank_gl(gl_entries)
            else:
                self._add_multi_receive_bank_gl(gl_entries)
        else:
            super().add_bank_gl_entries(gl_entries)

    def _add_multi_pay_bank_gl(self, gl_entries):
        total, base_total = self._multi_totals()
        gl_entry = {
            "account": self.paid_from,
            "account_currency": self.paid_from_account_currency,
            "against": self.party or None,
            "credit_in_account_currency": total,
            "credit_in_transaction_currency": total,
            "credit": base_total,
            "cost_center": self.cost_center,
            "post_net_value": True,
        }
        gl_entries.append(self.get_gl_dict(gl_entry, item=self))

    def _add_multi_receive_bank_gl(self, gl_entries):
        total, base_total = self._multi_totals()
        gl_entry = {
            "account": self.paid_to,
            "account_currency": self.paid_to_account_currency,
            "against": self.party or None,
            "debit_in_account_currency": total,
            "debit_in_transaction_currency": total,
            "debit": base_total,
            "cost_center": self.cost_center,
        }
        gl_entries.append(self.get_gl_dict(gl_entry, item=self))

    def make_gl_entries(self, cancel=0, adv_adj=0):
        if not self.is_multi_expense():
            super().make_gl_entries(cancel=cancel, adv_adj=adv_adj)
            return
        gl_entries = self.build_gl_map()
        gl_entries = process_gl_map(gl_entries, merge_entries=False)
        make_gl_entries(gl_entries, cancel=cancel, adv_adj=adv_adj, merge_entries=False)
        if cancel:
            cancel_exchange_gain_loss_journal(frappe._dict(doctype=self.doctype, name=self.name))
        else:
            self.make_exchange_gain_loss_journal()
        self.make_advance_gl_entries(cancel=cancel)

    # ---------------------------------------------------------------
    # amount auto-calculation (multi mode)
    # ---------------------------------------------------------------

    def set_amounts(self):
        super().set_amounts()
        if not self.is_multi_expense():
            return
        total, base_total = self._multi_totals()
        self.paid_amount = total
        self.base_paid_amount = base_total
        self.received_amount = total
        self.base_received_amount = base_total
        self.expense_total_amount = total
        self.expense_currency = self._bank_currency()

    # ---------------------------------------------------------------
    # on_cancel GL reversal
    # ---------------------------------------------------------------

    def on_cancel(self):
        if self.is_multi_expense():
            # same list as ERPNext's own PaymentEntry.on_cancel
            self.ignore_linked_doctypes = (
                "GL Entry", "Stock Ledger Entry", "Payment Ledger Entry",
                "Repost Payment Ledger", "Repost Payment Ledger Items",
                "Repost Accounting Ledger", "Repost Accounting Ledger Items",
                "Unreconcile Payment", "Unreconcile Payment Entries",
            )
            # make_gl_entries(cancel=1) already reverses the ledger (ERPNext's make_gl_entries with
            # cancel=True calls make_reverse_gl_entries). Reversing here as well booked it twice.
            self.make_gl_entries(cancel=1)
            self.update_payment_requests(cancel=True)
            self.update_payment_schedule(cancel=1)
            self.update_outstanding_amounts()
            self.set_status()
        else:
            super().on_cancel()

    # ---------------------------------------------------------------
    # currency (multi mode): lines are in the bank account's currency
    # ---------------------------------------------------------------

    def _bank_currency(self):
        return self.paid_from_account_currency if self.payment_type == "Pay" else self.paid_to_account_currency

    def _bank_rate(self):
        return flt(self.source_exchange_rate if self.payment_type == "Pay" else self.target_exchange_rate) or 1

    def _set_multi_exchange_rate(self):
        """Bank rate (source for Pay, target for Receive), copied to the other side.

        Keeps a rate the user typed; otherwise fetches it like ERPNext does.
        Replaces set_exchange_rate(), which would overwrite the Receive rate
        with the (empty) source rate because both currencies are mirrored.
        """
        company_currency = get_company_currency(self.company)
        bank_currency = self._bank_currency()
        rate_field = "source_exchange_rate" if self.payment_type == "Pay" else "target_exchange_rate"

        if not bank_currency or bank_currency == company_currency:
            rate = 1
        else:
            rate = flt(self.get(rate_field)) or get_exchange_rate(
                bank_currency, company_currency, self.posting_date
            )
            if not rate:
                frappe.throw(
                    _("Exchange rate from {0} to {1} is missing. Enter it or add a Currency Exchange record.").format(
                        bank_currency, company_currency
                    )
                )
        self.source_exchange_rate = rate
        self.target_exchange_rate = rate

    def _line_base_amount(self, line):
        return flt(flt(line.amount) * self._bank_rate(), self.precision("base_paid_amount"))

    def _multi_totals(self):
        """(total in bank currency, total in company currency = sum of rounded lines)."""
        lines = [row for row in (self.expense_items or []) if flt(row.amount)]
        total = flt(sum(flt(row.amount) for row in lines), self.precision("paid_amount"))
        base_total = flt(sum(self._line_base_amount(row) for row in lines), self.precision("base_paid_amount"))
        return total, base_total

    def _validate_line_currencies(self):
        """Each line account must be in company currency or in the bank's currency."""
        company_currency = get_company_currency(self.company)
        bank_currency = self._bank_currency()
        allowed = {company_currency, bank_currency} - {None}
        for line in self.expense_items or []:
            if not line.account:
                continue
            currency = get_account_currency(line.account)
            if currency not in allowed:
                frappe.throw(
                    _("Row {0}: account {1} is in {2}. Lines must be in {3}.").format(
                        line.idx, frappe.bold(line.account), currency, " / ".join(sorted(allowed))
                    )
                )

    def _validate_no_taxes_or_deductions(self):
        """The bank side in multi mode is the total of the lines only, so taxes or
        deductions would leave the GL unbalanced. Book them as lines instead."""
        if self.get("taxes") or self.get("deductions"):
            frappe.throw(
                _("Taxes and Deductions are not supported with Multi Expense / Revenue. "
                  "Add them as lines in the Expenses / Revenues table instead.")
            )
