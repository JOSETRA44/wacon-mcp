---
tags: [wacon, skill]
---

# Skill para Agentes

`skills/wacon-whatsapp/SKILL.md` — layout estándar instalable:

- Con el CLI de skills: `npx skills add JOSETRA44/wacon-mcp` (el CLI detecta `skills/*/SKILL.md`)
- Manual: copiar `skills/wacon-whatsapp/` a `~/.claude/skills/`
- La skill también se distribuye dentro del paquete npm (`files` incluye `skills/`)

## Qué aporta sobre los tools solos

Las descripciones de los [[Herramientas-MCP|tools]] ya codifican el workflow mínimo. La skill agrega lo que no cabe en una descripción:

- El **porqué** de cada paso (teoría de la mente: "un mensaje formal a tu mejor amigo delata a la IA")
- Cómo **traducir stats a decisiones de redacción** (burstLength ≥ 2 ⇒ dividir en varios mensajes cortos; tildeUsage bajo ⇒ escribir sin tildes)
- El ciclo de consolidación de [[Episodios]] como hábito post-conversación
- Reglas de seguridad conversacional (confirmación ante ambigüedad, honestidad sobre dry-run)

## Triggering

La descripción es deliberadamente "pushy": debe activarse ante "responde a mi mamá" o "avísale a Juan que llego tarde" aunque la palabra WhatsApp no aparezca.

Relacionado: [[Sistema-de-Memoria]], [[Roadmap]]
