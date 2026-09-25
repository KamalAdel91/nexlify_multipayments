app_name = "multi_payment"
app_title = "Multi Payment"
app_publisher = "Kamal Adel"
app_description = "Multi-Expense / Multi-Revenue lines on Payment Entry"
app_email = "Kamal.adel@outlook.com"
app_license = "mit"

required_apps = ["erpnext"]

doctype_js = {
	"Payment Entry": "public/js/payment_entry.js",
}

# extend_doctype_class (not override_doctype_class) so it layers on top of
# whichever class controls Payment Entry (e.g. hrms) instead of racing it.
extend_doctype_class = {
	"Payment Entry": ["multi_payment.overrides.payment_entry.MultiPaymentEntryMixin"],
}

after_install = "multi_payment.setup.install.after_install"
after_migrate = "multi_payment.setup.install.after_migrate"
before_uninstall = "multi_payment.setup.install.before_uninstall"
