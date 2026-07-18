// x-remote peer control panel — the interactive Discord layer over a peer relay.
//
// Renders a `/xr` slash command into an (ephemeral) control-panel message: the
// current surface's screen plus tap buttons (arrows / Enter / Esc / Ctrl-C /
// refresh / Type…) and, when more than one surface is exposed, a surface
// picker. "Type…" opens a modal so free text can be entered without shell
// syntax. Every action refreshes the panel in place.
//
// custom_id scheme:  xr:key:<Key> | xr:snap | xr:type | xr:use
// It talks Discord only through the DiscordBridge (respondInteraction /
// editInteraction / request); all surface work goes through the relay.

const B = { PRIMARY: 1, SECONDARY: 2, SUCCESS: 3, DANGER: 4 };

export function createPeerPanel({ bridge, relay, guildId }) {
  const btn = (custom_id, label, style = B.SECONDARY) => ({ type: 2, style, label, custom_id });

  function buttonRows() {
    return [
      {
        type: 1,
        components: [
          btn('xr:key:Up', '↑'),
          btn('xr:key:Down', '↓'),
          btn('xr:key:Left', '←'),
          btn('xr:key:Right', '→'),
          btn('xr:snap', '🔄', B.PRIMARY),
        ],
      },
      {
        type: 1,
        components: [
          btn('xr:key:Enter', '⏎ Enter', B.SUCCESS),
          btn('xr:key:Escape', '⎋ Esc'),
          btn('xr:key:C-c', '^C', B.DANGER),
          btn('xr:type', '⌨ Type…', B.PRIMARY),
        ],
      },
    ];
  }

  async function selectRow() {
    let list = await relay.surfaces();
    if (list.length <= 1) return []; // nothing to pick among 0–1 surfaces
    // A Discord select caps at 25 options; keep the current surface in view so
    // it is never stuck-unselectable when more than 25 surfaces are exposed.
    if (list.length > 25) {
      const cur = list.find((s) => s.name === relay.current);
      list = [cur, ...list.filter((s) => s.name !== relay.current)].filter(Boolean);
    }
    return [
      {
        type: 1,
        components: [
          {
            type: 3, // string select
            custom_id: 'xr:use',
            placeholder: 'surface',
            options: list.slice(0, 25).map((s) => ({
              label: s.name,
              value: s.name,
              default: s.name === relay.current,
            })),
          },
        ],
      },
    ];
  }

  async function panel() {
    const content = `**\`${relay.current}\`**\n` + (await relay.snapshot());
    return { content: content.slice(0, 1990), components: [...buttonRows(), ...(await selectRow())] };
  }

  function modalData() {
    return {
      custom_id: 'xr:type:modal',
      title: `Type into ${relay.current}`.slice(0, 45),
      components: [
        {
          type: 1,
          components: [
            {
              type: 4, // text input
              custom_id: 'text',
              label: 'text (sent to the surface + Enter)',
              style: 1, // short
              required: true,
              max_length: 400,
            },
          ],
        },
      ],
    };
  }

  async function registerCommand() {
    if (!bridge.appId) throw new Error('bridge.appId is not known yet (wait for READY)');
    await bridge.request(`/applications/${bridge.appId}/guilds/${guildId}/commands`, {
      method: 'POST',
      body: JSON.stringify({
        name: 'xr',
        description: 'Remote-control the current term-mesh surface',
        type: 1,
      }),
    });
  }

  // Build + push the panel, but never leave the interaction stuck on the
  // deferred spinner: if the build or the edit fails (e.g. an invalid
  // component), fall back to a plain error message so the user always gets a
  // resolved response instead of an endless "thinking…".
  async function showPanel(token) {
    let body;
    try {
      body = await panel();
    } catch (e) {
      body = { content: `panel build failed: ${String(e.message).slice(0, 300)}`, components: [] };
    }
    try {
      await bridge.editInteraction(token, body);
    } catch (e) {
      try {
        await bridge.editInteraction(token, {
          content: `panel update failed: ${String(e.message).slice(0, 300)}`,
          components: [],
        });
      } catch {
        /* discord.mjs already logged the interaction error; nothing else to do */
      }
    }
  }

  async function handleInteraction(i) {
    // i.type: 2 = slash command, 3 = component, 5 = modal submit
    if (i.type === 2) {
      await bridge.respondInteraction(i.id, i.token, { type: 5, data: { flags: 64 } }); // deferred, ephemeral
      return showPanel(i.token);
    }
    if (i.type === 3) {
      const cid = i.data.custom_id;
      if (cid === 'xr:type') {
        return bridge.respondInteraction(i.id, i.token, { type: 9, data: modalData() }); // open modal
      }
      await bridge.respondInteraction(i.id, i.token, { type: 6 }); // deferred update
      if (cid === 'xr:use') relay.setSurface(i.data.values?.[0]);
      else if (cid.startsWith('xr:key:')) await relay.sendKeys(cid.slice('xr:key:'.length));
      // 'xr:snap' falls through to a plain refresh
      return showPanel(i.token);
    }
    if (i.type === 5) {
      await bridge.respondInteraction(i.id, i.token, { type: 6 }); // deferred update
      const text = i.data.components?.[0]?.components?.[0]?.value || '';
      if (text) await relay.sendText(text);
      return showPanel(i.token);
    }
  }

  return { registerCommand, handleInteraction };
}
