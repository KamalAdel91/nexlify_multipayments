"""Custom fields on Payment Entry for the Multi-Expense / Revenue feature."""

import frappe
from frappe.custom.doctype.custom_field.custom_field import create_custom_fields

CUSTOM_FIELDS = {
	"Payment Entry": [
		{
			"fieldname": "multi_expense",
			"fieldtype": "Check",
			"label": "Multi Expense / Revenue",
			"insert_after": "mode_of_payment",
			"description": "Enable company expense/revenue table (no party required)",
			"depends_on": "eval:doc.payment_type != 'Internal Transfer'",
		},
		{
			"fieldname": "expense_section",
			"fieldtype": "Section Break",
			"label": "Company Expenses / Revenues",
			"insert_after": "multi_expense",
			"depends_on": "eval:doc.multi_expense == 1",
		},
		{
			"fieldname": "expense_items",
			"fieldtype": "Table",
			"label": "Expense / Revenue Items",
			"options": "Payment Entry Expense Account",
			"insert_after": "expense_section",
		},
		{
			"fieldname": "expense_total_amount",
			"fieldtype": "Currency",
			"label": "Total Amount",
			"insert_after": "expense_items",
			"read_only": 1,
			"depends_on": "eval:doc.multi_expense == 1",
		},
	],
}


def after_install():
	create_custom_fields(CUSTOM_FIELDS, update=True)
	_add_dimensions()


def after_migrate():
	create_custom_fields(CUSTOM_FIELDS, update=True)
	_add_dimensions()


def before_uninstall():
	for doctype, fields in CUSTOM_FIELDS.items():
		for df in fields:
			name = frappe.db.get_value("Custom Field", {"dt": doctype, "fieldname": df["fieldname"]})
			if name:
				frappe.delete_doc("Custom Field", name, ignore_permissions=True)
	frappe.clear_cache(doctype="Payment Entry")


def _add_dimensions():
	"""Every Accounting Dimension (existing or added later) gets a field on the expense lines."""
	from erpnext.accounts.doctype.accounting_dimension.accounting_dimension import (
		create_accounting_dimensions_for_doctype,
	)
	create_accounting_dimensions_for_doctype("Payment Entry Expense Account")
