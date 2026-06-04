// SIGOS – global client utilities

frappe.provide("sigos");

sigos.get_settings = function () {
	return frappe.xcall("frappe.client.get", {
		doctype: "SIGOS Settings",
		name: "SIGOS Settings",
	});
};

/** Returns a promise resolving to a single setting value. */
sigos.setting = function (fieldname) {
	return sigos.get_settings().then((s) => s[fieldname]);
};

/** Style a button inside a form with the danger colour. */
sigos.danger_btn = function (frm, fieldname) {
	const btn = frm.fields_dict[fieldname]?.$input;
	if (btn) btn.addClass("btn-sigos-danger");
};
