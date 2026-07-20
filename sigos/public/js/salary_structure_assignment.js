// SIGOS - Salary Structure Assignment: suggest Base as soon as an Employee is
// picked, using the same resolution as the "Definir Salário" flow (manual
// override > Project's per-regime rate > Categoria's default, floored at the
// SIGOS minimum). A suggestion only — never overwrites a Base the user (or a
// previous save) already set.

frappe.ui.form.on("Salary Structure Assignment", {
	employee(frm) {
		if (!frm.doc.employee || frm.doc.base) return;
		frappe.call({
			method: "sigos.api.resolver_salario_base_por_funcionario",
			args: { employee: frm.doc.employee },
			callback: (r) => {
				if (r.message) frm.set_value("base", r.message);
			},
		});
	},
});
