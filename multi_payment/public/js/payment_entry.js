// Multi-Expense / Multi-Revenue — Payment Entry client-side.
//
// When `multi_expense` is ticked:
//   - Party & reference sections are hidden.
//   - The expense/revenue child table is shown.
//   - Labels switch: Pay  → "Expenses",  Receive → "Revenues".
//   - Account filter: Pay → Expense + Tax,  Receive → Income.

frappe.ui.form.on("Payment Entry", {
    refresh(frm) {
        _multi_refresh(frm);
    },

    payment_type(frm) {
        // On Receive/Internal Transfer we never force-reset multi_expense.
        _apply_multi_visibility(frm);
        _update_labels(frm);
    },

    multi_expense(frm) {
        _apply_multi_visibility(frm);
        _update_labels(frm);
        if (frm.doc.multi_expense) {
            _recalc_total(frm);
        }
    },

    before_save(frm) {
        if (frm.doc.multi_expense) {
            frm.doc.party_type = "";
            frm.doc.party = "";
        }
    },

    // Bank currency / rate changes (ERPNext's own handlers run first and set
    // the rate asynchronously; these fire again once it lands).
    paid_from_account_currency: _recalc_if_multi,
    paid_to_account_currency: _recalc_if_multi,
    source_exchange_rate: _recalc_if_multi,
    target_exchange_rate: _recalc_if_multi,
});

function _recalc_if_multi(frm) {
    if (frm.doc.multi_expense) _recalc_total(frm);
}

// ── Grid row events ──

frappe.ui.form.on("Payment Entry Expense Account", {
    account(frm, cdt, cdn) {
        const row = frappe.get_doc(cdt, cdn);
        if (row.account && !row.cost_center && frm.doc.cost_center) {
            frappe.model.set_value(cdt, cdn, "cost_center", frm.doc.cost_center);
        }
    },

    amount(frm) {
        _recalc_total(frm);
    },

    expense_items_remove(frm) {
        _recalc_total(frm);
    },
});

// ── helpers ──

function _multi_refresh(frm) {
    _setup_account_query(frm);
    _apply_multi_visibility(frm);
    _update_labels(frm);
    // Re-assert the total on every refresh: native handlers can momentarily
    // revert paid_amount/received_amount after a row edit.
    if (frm.doc.multi_expense) {
        _recalc_total(frm);
    }
}

function _setup_account_query(frm) {
    if (frm.fields_dict.expense_items) {
        frm.fields_dict.expense_items.grid.get_field("account").get_query =
            function () {
                if (!frm.doc.company) return { filters: {} };
                // Any leaf account in the company - not restricted to
                // Expense (Pay) or Income (Receive) only, since a row can
                // also be used to reduce/offset an existing expense or
                // revenue account rather than always adding a new one.
                return {
                    filters: {
                        company: frm.doc.company,
                        is_group: 0,
                    },
                };
            };
        // Restrict Party Type in the grid to actual party doctypes
        // (Customer, Supplier, Employee, ...), not every DocType.
        frm.fields_dict.expense_items.grid.get_field("party_type").get_query =
            function () {
                return {
                    filters: {
                        name: ["in", Object.keys(frappe.boot.party_account_types || {})],
                    },
                };
            };
    }
}

function _native_df(fieldname) {
	// The Payment Entry doctype's own unmodified field definition, read
	// fresh from meta every time - never a value we invented or a runtime
	// copy that our own set_df_property calls may have already mutated.
	// frappe.meta.get_docfield() is the long-established client-side API
	// for this (frappe.get_meta(...).get_field(...) does not exist here).
	return frappe.meta.get_docfield("Payment Entry", fieldname) || {};
}

function _restore_native(frm, fieldname, prop) {
	const native = _native_df(fieldname);
	frm.set_df_property(fieldname, prop, native[prop] || 0);
}

function _apply_multi_visibility(frm) {
	const on = frm.doc.multi_expense == 1
		&& frm.doc.payment_type !== "Internal Transfer";

	// Toggle multi-expense checkbox visibility
	if (frm.fields_dict.multi_expense) {
		frm.set_df_property(
			"multi_expense", "hidden",
			frm.doc.payment_type === "Internal Transfer" ? 1 : 0
		);
	}

	const party_fields = [
		"party_type", "party", "party_name",
		"party_bank_account", "contact_person", "contact_email",
	];
	const ref_sections = [
		"section_break_14",   // Reference
		"references",
		"section_break_34",   // Writeoff
		"total_allocated_amount", "base_total_allocated_amount",
		"unallocated_amount",
		"difference_amount", "write_off_difference_amount",
	];
	const extra_sections = [
		"deductions",
		"taxes", "total_taxes_and_charges", "base_total_taxes_and_charges",
		"paid_amount_after_tax", "base_paid_amount_after_tax",
		"received_amount_after_tax", "base_received_amount_after_tax",
	];

	const multi_fields = [
		"expense_section",
		"expense_items",
		"expense_total_amount",
	];

	// party_type/party/party_name are genuinely required by vanilla
	// Payment Entry; the rest of party_fields are naturally optional.
	// Either way, when the feature is off we never invent a value -
	// we read Payment Entry's own native reqd/hidden back out of meta.
	for (const field of party_fields) {
		if (!frm.fields_dict[field]) continue;
		if (on) {
			frm.set_df_property(field, "hidden", 1);
			frm.set_df_property(field, "reqd", 0);
		} else {
			_restore_native(frm, field, "hidden");
			_restore_native(frm, field, "reqd");
		}
	}
	for (const field of ref_sections.concat(extra_sections)) {
		if (!frm.fields_dict[field]) continue;
		if (on) {
			frm.set_df_property(field, "hidden", 1);
		} else {
			_restore_native(frm, field, "hidden");
		}
	}
	for (const field of multi_fields) {
		if (frm.fields_dict[field]) {
			frm.set_df_property(field, "hidden", on ? 0 : 1);
		}
	}

	// Make the paid_from / paid_to optional in multi mode; native reqd
	// otherwise (never a hardcoded 1 - read straight from meta).
	if (frm.fields_dict.paid_to) {
		if (on && frm.doc.payment_type === "Pay") {
			frm.set_df_property("paid_to", "reqd", 0);
		} else {
			_restore_native(frm, "paid_to", "reqd");
		}
	}
	if (frm.fields_dict.paid_from) {
		if (on && frm.doc.payment_type === "Receive") {
			frm.set_df_property("paid_from", "reqd", 0);
		} else {
			_restore_native(frm, "paid_from", "reqd");
		}
	}

	// Relax mandatory fields that are auto-populated or irrelevant in multi
	// mode; native reqd otherwise (never a hardcoded 1).
	const relaxPay = ["paid_to_account_currency", "target_exchange_rate"];
	const relaxReceive = ["paid_from_account_currency", "source_exchange_rate"];
	const relaxAll = ["paid_amount", "received_amount"];  // auto-calculated from the table

	for (const field of relaxPay.concat(relaxAll)) {
		if (!frm.fields_dict[field]) continue;
		if (on && frm.doc.payment_type === "Pay") {
			frm.set_df_property(field, "reqd", 0);
		} else {
			_restore_native(frm, field, "reqd");
		}
	}
	for (const field of relaxReceive.concat(relaxAll)) {
		if (!frm.fields_dict[field]) continue;
		if (on && frm.doc.payment_type === "Receive") {
			frm.set_df_property(field, "reqd", 0);
		} else {
			_restore_native(frm, field, "reqd");
		}
	}
}

function _update_labels(frm) {
    if (!frm.fields_dict.expense_section) return;
    if (frm.doc.payment_type === "Receive") {
        frm.set_df_property("expense_section", "label", "Company Revenues");
    } else {
        frm.set_df_property("expense_section", "label", "Company Expenses");
    }
}

function _bank_currency(frm) {
    return frm.doc.payment_type === "Receive"
        ? frm.doc.paid_to_account_currency
        : frm.doc.paid_from_account_currency;
}

function _bank_rate(frm) {
    return flt(frm.doc.payment_type === "Receive"
        ? frm.doc.target_exchange_rate
        : frm.doc.source_exchange_rate) || 1;
}

function _recalc_total(frm) {
    // Mirrors overrides/payment_entry.py: line amounts are in the bank's
    // currency; base = sum of each line converted at the bank rate, rounded.
    const rate = _bank_rate(frm);
    const base_precision = precision("base_paid_amount");
    let total = 0;
    let base_total = 0;
    for (const row of frm.doc.expense_items || []) {
        total += flt(row.amount);
        base_total += flt(flt(row.amount) * rate, base_precision);
    }
    total = flt(total, precision("paid_amount"));
    base_total = flt(base_total, base_precision);
    const currency = _bank_currency(frm) || frm.doc.expense_currency;

    // Only touch the doc when something changed: this runs on every refresh,
    // and an unconditional frm.dirty() kept a saved doc "unsaved" (no Submit).
    if (
        flt(frm.doc.paid_amount) === total &&
        flt(frm.doc.received_amount) === total &&
        flt(frm.doc.expense_total_amount) === total &&
        flt(frm.doc.base_paid_amount) === base_total &&
        flt(frm.doc.base_received_amount) === base_total &&
        frm.doc.expense_currency === currency
    ) {
        return;
    }

    // Written straight to frm.doc, not frm.set_value: set_value would fire
    // ERPNext's paid_amount/received_amount handlers, whose async reference
    // allocation resets these totals a moment later (no references here).
    frm.doc.paid_amount = total;
    frm.doc.received_amount = total;
    frm.doc.expense_total_amount = total;
    frm.doc.base_paid_amount = base_total;
    frm.doc.base_received_amount = base_total;
    frm.doc.expense_currency = currency;
    frm.dirty();
    for (const f of ["paid_amount", "received_amount", "expense_total_amount",
                     "base_paid_amount", "base_received_amount", "expense_items"]) {
        frm.refresh_field(f);
    }
}

// Expense / revenue lines: only active projects of the payment's company
frappe.ui.form.on("Payment Entry", {
	setup(frm) {
		frm.set_query("project", "expense_items", () => ({
			filters: { is_active: "Yes", company: frm.doc.company },
		}));
	},
});

