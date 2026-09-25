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
});

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

function _recalc_total(frm) {
    let total = 0;
    if (frm.doc.expense_items) {
        for (const row of frm.doc.expense_items) {
            total += flt(row.amount);
        }
    }

    // Bail out early if nothing actually changed. This function now runs
    // on every refresh(frm) - including the refresh Frappe triggers right
    // after a successful Save - so calling frm.dirty() unconditionally
    // was re-marking a just-saved document as having unsaved changes on
    // every single refresh cycle. That kept Frappe perpetually treating
    // the document as "not fully saved", which is why the Submit button
    // never appeared: only re-dirty (and re-set) when the computed total
    // genuinely differs from what's already on frm.doc.
    if (
        flt(frm.doc.paid_amount) === total &&
        flt(frm.doc.received_amount) === total &&
        flt(frm.doc.expense_total_amount) === total
    ) {
        return;
    }

    // Root cause of the earlier flicker: frm.set_value("paid_amount"/
    // "received_amount", ...) fires ERPNext's own native paid_amount/
    // received_amount handlers, which - among other things - call
    // allocate_party_amount_against_ref_docs(). That does an ASYNC server
    // round-trip (frm.call("allocate_amount_to_references", ...)) that
    // recomputes the allocated/unallocated amount from the references
    // table. In multi-expense mode there are no references at all, so
    // that async call comes back and resets paid_amount/received_amount
    // toward 0 a moment after we set them - the "flicker".
    //
    // These two fields are purely a display/derived total in multi mode
    // (nothing here is meant to allocate against invoices), so we bypass
    // frm.set_value entirely for them and write frm.doc directly - this
    // never triggers the native field-change chain, so none of that
    // reference-allocation machinery ever runs in the first place.
    frm.doc.paid_amount = total;
    frm.doc.received_amount = total;
    frm.doc.expense_total_amount = total;
    // Mirror overrides/payment_entry.py's set_amounts(): the server sets
    // base_paid_amount/base_received_amount = total correctly at save
    // time, but Frappe's client-side mandatory-field check runs *before*
    // that, still seeing whatever was last computed here (0, since we no
    // longer trigger the native chain that used to fill it in). Set the
    // same value client-side too so that pre-save check passes.
    frm.doc.base_paid_amount = total;
    frm.doc.base_received_amount = total;
    frm.dirty();
    frm.refresh_field("paid_amount");
    frm.refresh_field("received_amount");
    frm.refresh_field("expense_total_amount");
    frm.refresh_field("base_paid_amount");
    frm.refresh_field("base_received_amount");
}
