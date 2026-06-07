frappe.ui.form.on("Rotatividade", {

	after_submit(frm) {
		if (frm.doc.workflow_state !== "Aprovado") return;
		sigos.wizard_actualizar_escalas({
			vigilante: frm.doc.vigilante,
			tipo: "rotatividade",
			// Pre-fill the known replacement (APV only)
			novo_vigilante_sugerido: frm.doc.abreviatura_op === "APV"
				? frm.doc.novo_vigilante
				: null,
		});
	},

	onload(frm) {
		// Filter novo_posto by delegacao + estado=Activo
		frm.set_query("novo_posto", () => ({
			filters: {
				delegacao: frm.doc.delegacao,
				estado: "Activo"
			}
		}));

		// Posto para onde o vigilante vai quando passa a Reserva
		frm.set_query("novo_posto_do_reserva", () => ({
			filters: {
				delegacao: frm.doc.delegacao,
				estado: "Activo"
			}
		}));

		// Filter vigilante: Activo, not Administrativo
		frm.set_query("vigilante", () => ({
			filters: [
				["status", "=", "Activo"],
				["categoria", "!=", "Administrativo"]
			]
		}));

		// Filter novo_vigilante: same delegacao, Activo, not Administrativo
		frm.set_query("novo_vigilante", () => ({
			filters: [
				["delegacao", "=", frm.doc.delegacao],
				["status", "=", "Activo"],
				["categoria", "!=", "Administrativo"]
			]
		}));
	},

	delegacao(frm) {
		frm.set_query("novo_posto", () => ({
			filters: {
				delegacao: frm.doc.delegacao,
				estado: "Activo"
			}
		}));
		frm.set_query("novo_vigilante", () => ({
			filters: [
				["delegacao", "=", frm.doc.delegacao],
				["status", "=", "Activo"],
				["categoria", "!=", "Administrativo"]
			]
		}));
		frm.set_query("novo_posto_do_reserva", () => ({
			filters: {
				delegacao: frm.doc.delegacao,
				estado: "Activo"
			}
		}));
	},

	novo_vigilante(frm) {
		// When substituto is chosen, pre-fill alocado_ao_posto with antigo_posto
		frm.set_value("alocado_ao_posto", frm.doc.antigo_posto);
	},

	alocar_vigilante_substituto(frm) {
		frm.set_value("novo_vigilante", "");
		frm.set_value("alocado_ao_posto", "");
	},

	before_save(frm) {
		const {
			vigilante,
			novo_vigilante,
			cliente_antigo_posto,
			cliente_novo_posto,
			categoria_vigilante,
			categoria_vigilante_a_alocar,
			abreviatura_op,
			alocar_vigilante_substituto
		} = frm.doc;

		// Skip validation if RVP and not allocating substituto
		if (abreviatura_op === "RVP" && alocar_vigilante_substituto === "Não") {
			return;
		}

		let deve_executar_validacoes = false;
		let deve_validar_cliente = false;

		if (abreviatura_op === "APV") {
			deve_executar_validacoes = true;
			deve_validar_cliente = true;
		} else if (abreviatura_op === "RVP" && alocar_vigilante_substituto === "Sim") {
			deve_executar_validacoes = true;
			deve_validar_cliente = false;
		}

		if (!deve_executar_validacoes) return;

		// Validate categoria match
		if (
			categoria_vigilante_a_alocar &&
			categoria_vigilante !== categoria_vigilante_a_alocar &&
			categoria_vigilante !== "Reserva" &&
			categoria_vigilante_a_alocar !== "Reserva"
		) {
			frappe.msgprint({
				title: __("Validação de Categoria"),
				message: __(
					`A Categoria do Vigilante <b>${vigilante}</b> é <b>${categoria_vigilante}</b>, mas a do substituto <b>${novo_vigilante}</b> é <b>${categoria_vigilante_a_alocar}</b>. As categorias devem ser iguais.`
				),
				indicator: "red"
			});
			frappe.validated = false;
			return;
		}

		// Cliente validation + 3-month check
		const clientesDiferentes = (
			cliente_antigo_posto &&
			cliente_novo_posto &&
			cliente_antigo_posto !== cliente_novo_posto
		);

		if (frm._tres_meses_confirmado) {
			frm._tres_meses_confirmado = false;
			frm._cliente_confirmado = false;
			return;
		}

		if (novo_vigilante && deve_validar_cliente && clientesDiferentes && !frm._cliente_confirmado) {
			frappe.confirm(
				__(
					`Os clientes dos postos são diferentes.<br>` +
					`Vigilante <b>${vigilante}</b> está no cliente: <b>${cliente_antigo_posto}</b><br>` +
					`Substituto <b>${novo_vigilante}</b> está no cliente: <b>${cliente_novo_posto}</b><br><br>` +
					`Deseja continuar mesmo assim?`
				),
				function () {
					frappe.prompt(
						[{
							label: "Motivo de Rotatividade com Clientes Diferentes",
							fieldname: "motivo_rotatividade",
							fieldtype: "Small Text",
							reqd: 1
						}],
						function (values) {
							frm.set_value("motivo_rotatividade", values.motivo_rotatividade);
							frm._cliente_confirmado = true;
							_verificar_3meses(frm, vigilante);
						},
						__("Justificar Rotatividade"),
						__("Continuar")
					);
				},
				function () {
					frappe.validated = false;
				}
			);
			frappe.validated = false;
			return;
		}

		if (!frm._tres_meses_confirmado && (!deve_validar_cliente || !clientesDiferentes || frm._cliente_confirmado)) {
			_verificar_3meses(frm, vigilante);
			frappe.validated = false;
		}
	},

	refresh(frm) {
		frm.set_df_property("motivo_3meses", "read_only", 1);
		frm.set_df_property("motivo_rotatividade", "read_only", 1);

		if (frm.is_new()) {
			frm.fields.forEach(field => {
				if (!["motivo_3meses", "motivo_rotatividade"].includes(field.df.fieldname)) {
					frm.set_df_property(field.df.fieldname, "read_only", 0);
				}
			});
			return;
		}

		if (frm.doc.workflow_state === "Pendente De Aprovação") {
			frm.fields.forEach(field => {
				frm.set_df_property(field.df.fieldname, "read_only", 1);
			});
		} else {
			frm.fields.forEach(field => {
				if (!["motivo_3meses", "motivo_rotatividade"].includes(field.df.fieldname)) {
					frm.set_df_property(field.df.fieldname, "read_only", 0);
				}
			});
		}
	}
});


function _verificar_3meses(frm, vigilante) {
	frappe.call({
		method: "frappe.client.get_list",
		args: {
			doctype: "Rotatividade",
			fields: ["data"],
			filters: {
				vigilante: vigilante,
				workflow_state: "Aprovado"
			},
			order_by: "data desc",
			limit_page_length: 1
		},
		callback(r) {
			const ultima_data = (r.message && r.message.length > 0) ? r.message[0].data : null;

			const _processar = function (data_base, tipo) {
				if (!data_base) {
					frm._tres_meses_confirmado = true;
					frappe.validated = true;
					frm.save();
					return;
				}

				const hoje = frappe.datetime.now_date();
				const diff_dias = frappe.datetime.get_diff(hoje, data_base);
				const limite = 90;
				const faltam = limite - diff_dias;

				if (diff_dias >= limite) {
					frm._tres_meses_confirmado = true;
					frappe.validated = true;
					frm.save();
				} else {
					frappe.confirm(
						__(
							`O vigilante <b>${vigilante}</b> ainda não completou ${limite} dias desde a última ${tipo} (<b>${data_base}</b>). Faltam <b>${faltam}</b> dias. Deseja continuar?`
						),
						function () {
							frappe.prompt(
								[{
									label: "Motivo de Rotatividade Antes de 3 Meses",
									fieldname: "motivo_3meses",
									fieldtype: "Small Text",
									reqd: 1
								}],
								function (values) {
									frm.set_value("motivo_3meses", values.motivo_3meses);
									frm._tres_meses_confirmado = true;
									frappe.validated = true;
									frm.save();
								},
								__("Justificar"),
								__("Continuar")
							);
						},
						function () {
							frappe.validated = false;
						}
					);
				}
			};

			if (ultima_data) {
				_processar(ultima_data, "Rotatividade");
			} else {
				frappe.call({
					method: "frappe.client.get",
					args: { doctype: "Vigilante", name: vigilante, fields: ["data_admissao"] },
					callback(res) {
						const data_admissao = res.message ? res.message.data_admissao : null;
						_processar(data_admissao, "Admissão");
					}
				});
			}
		}
	});
}
