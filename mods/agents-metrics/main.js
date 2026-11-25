// Agents in grouped or priority views; parents take their most urgent sub-agent's place.
// A viewed done agent stays in Done until left.

import { View, div, image, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { avatar, animated } from "./avatar.js";
import { agents, terminals, panes, focused, spaces, run, theme, shared, setShared, setAgentOrder, openOverlay, closeOverlay, props, window, layout } from "herdr";

// The Metrics summary box's Game Boy screen (agent-metrics hero()), carried over to this list: a gray-green
// LCD with near-black ink inside a light bezel, rust when an agent needs you. Square blocks, 2px rules,
// JetBrains Mono caps; the focused row is inverted like the selected tab. Keep in step with hero().
const MONO = "JetBrains Mono";
const LCD = { bg: "#7a8076", ink: "#0a1312", edge: "#95a7a7", hotBg: "#95553a", hotEdge: "#b09270", mute: "#2c3431" };
const lcd = (hot) => ({ bg: hot ? LCD.hotBg : LCD.bg, fg: LCD.ink, edge: hot ? LCD.hotEdge : LCD.edge, mute: LCD.mute });
// The same screen with ink and paper swapped: the focused row.
const invert = (p) => ({ ...p, bg: p.fg, fg: p.bg, mute: p.bg });

// Low-poly rainbow border for a working agent's row: flat rainbow facets around the edge, alternately lit and
// shaded like polygon faces, stepping one facet per tick (the avatar's 200ms timer). An overlay: it never
// changes the row's size and takes no clicks of its own.
const RAINBOW = ["#ff4d4d", "#ff9f43", "#ffd93d", "#4ade80", "#38bdf8", "#818cf8", "#c084fc"];
const shade = (hex, k) => "#" + [1, 3, 5].map(i => Math.round(parseInt(hex.slice(i, i + 2), 16) * k).toString(16).padStart(2, "0")).join("");
const FX = 10, FY = 2, EDGE = 2;
function rainbowEdge(tick) {
  const n = 2 * (FX + FY);
  const at = p => { const i = (((p - tick) % n) + n) % n, b = RAINBOW[i % RAINBOW.length]; return i % 2 ? shade(b, 0.72) : b; };
  // Facets need an explicit cross size: a row centers its children instead of stretching them, so a facet
  // with only flex_1 is 0px tall and the top and bottom edges vanish.
  const hrun = (count, pos) => Array.from({ length: count }, (_, i) => div().flex_1().h_full().bg(at(pos(i))));
  const vrun = (count, pos) => Array.from({ length: count }, (_, i) => div().flex_1().w_full().bg(at(pos(i))));
  // One absolute strip per edge, so all four always draw: top and bottom run the width, left and right the height.
  return div().absolute().inset_0().overflow_hidden()
    .child(v_flex().absolute().inset_0().child(h_flex().w_full().h(EDGE).children(hrun(FX, i => i))))
    .child(h_flex().absolute().inset_0().justify_end().child(v_flex().h_full().w(EDGE).children(vrun(FY, i => FX + i))))
    .child(v_flex().absolute().inset_0().justify_end().child(h_flex().w_full().h(EDGE).children(hrun(FX, i => FX + FY + (FX - 1 - i)))))
    .child(h_flex().absolute().inset_0().child(v_flex().h_full().w(EDGE).children(vrun(FY, i => 2 * FX + FY + (FY - 1 - i)))));
}

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

// The sidebar's rail goes by its width, not a flag: dragging its edge narrows it too.
const narrow = () => (find(layout(), "sidebar")?.size?.px ?? Infinity) < 160;

// To the rail (on macOS wide enough for the traffic lights), or back to the width it had.
function toggleSidebar() {
  const width = find(layout(), "sidebar")?.size?.px;
  if (!narrow()) setShared("sidebar.width", width);
  // Mods edited before the rail went by width still read the flag.
  setShared("sidebar.collapsed", !narrow());
  run("layout.resize", { id: "sidebar", px: narrow() ? (shared("sidebar.width") ?? 268) : window()?.platform === "macos" ? 76 : 44 });
}

const clean = (s) => (s ?? "").replace(/^[^\p{L}\p{N}]+/u, "").trim();

function lead(tab, all = panes()) {
  const mine = all.filter(p => p.tab === tab.id && p.terminal);
  return mine.find(p => p.program?.agent) ?? mine.find(p => p.focused) ?? mine[0];
}

function title(tab, l) {
  const prog = l?.program?.name;
  const live = clean(l?.title);
  const telling = live && live !== prog && !/^[~/]|^[A-Za-z]:\\/.test(live) && !live.includes("@") && live.toLowerCase() !== l?.program?.key;
  return (tab.name === prog || !tab.named) && telling ? live : tab.name;
}
const RANK = { blocked: 4, done: 3, working: 2, idle: 1 };
// A sub-agent without a pane isn't in agents(): its raw word, error counting as
// blocked. It's never done: it reports to its parent, and the parent's done is the news.
const kidStatus = (k, listed) => {
  const s = listed.get(k.address) ?? k.status;
  return s === "error" ? "blocked" : s === "done" ? "idle" : s;
};
const SORTS = [
  { id: "priority", label: "Priority", icon: "clock" },
  { id: "grouped", label: "Grouped by space", icon: "layers" },
];
const sortOf = () => SORTS.find((s) => s.id === shared("agents.sort")) ?? SORTS[0];
const SECTION = { 4: "Needs you", 3: "Done", 2: "Working", 1: "Idle" };
const SECTION_STATUS = { 4: "blocked", 3: "done", 2: "working" };

function duration(ms) {
  const m = Math.floor(ms / 60000);
  if (m < 1) return "<1m";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h` : `${Math.floor(h / 24)}d`;
}

// The agent's icon from the app's program table: a one-color glyph or a picture.
function icon(p, size, color) {
  if (!p?.icon) return null;
  return p.tint ? svg(p.icon).size(size).flex_none().text_color(color) : image(p.icon).w(size).h(size).flex_none();
}

export default class Agents extends View {
  init(_props, cx) {
    if (props()?.sortMenu) return;
    this.folded = new Set();
    // Each agent's last state and when it changed (ms), kept across restarts.
    this.changed = JSON.parse(localStorage.getItem("changed") ?? "{}");
    this.pendingPins = JSON.parse(localStorage.getItem("pins") ?? "[]");
    if (!this.pendingPins.length) localStorage.removeItem("pins");
    this.migratingPins = new Set();
    this.tick = 0; this.anim = false;
    cx.timer.every(200, (cx) => { if (this.anim) { this.tick++; cx.notify(); } });
    cx.timer.every(30000, (cx) => cx.notify());
  }

  // Stamps agents whose state changed. Done and idle count as one: looking at a
  // finished agent turns done into idle, and looking isn't the agent doing anything.
  track(list, now) {
    let dirty = false;
    for (const a of list) {
      const s = a.status === "done" ? "idle" : a.status;
      if (this.changed[a.address]?.s === s) continue;
      this.changed[a.address] = { s, at: now };
      dirty = true;
    }
    if (!dirty) return;
    // Gone and old: the list alone is empty right after a start.
    const listed = new Set(list.map((a) => a.address));
    for (const [k, c] of Object.entries(this.changed)) if (!listed.has(k) && now - c.at > 30 * 86400000) delete this.changed[k];
    localStorage.setItem("changed", JSON.stringify(this.changed));
  }

  // Keep offline pins until their terminal returns, and keep each pending until
  // core echoes the label so a failed write doesn't erase the old pin.
  migratePins(all) {
    const listed = new Map(all.filter((t) => t.state === "live").map((t) => [t.address, t]));
    const pending = this.pendingPins.filter((address) => {
      const terminal = listed.get(address);
      if (!terminal) return true;
      if (terminal.labels?.["herdr.pinned"]) return false;
      if (!this.migratingPins.has(address)) {
        this.migratingPins.add(address);
        run("terminal.pin", { terminal: address, pinned: true });
      }
      return true;
    });
    if (pending.length === this.pendingPins.length) return;
    this.pendingPins = pending;
    if (pending.length) localStorage.setItem("pins", JSON.stringify(pending));
    else localStorage.removeItem("pins");
  }

  since(a) {
    return this.changed[a.address]?.at ?? 0;
  }

  // Looking at a done agent makes it idle; it stays with Done until you leave
  // it rather than drop away under you. Any other change moves it at once.
  hold(list) {
    const cur = list.find((a) => a.focused);
    const same = cur && cur.address === this.held?.address;
    // Arriving, or any change but done turning idle, sets what it was.
    if (!same || cur.status !== "idle") this.held = cur ? { address: cur.address, rank: RANK[cur.status] ?? 0 } : null;
  }

  rank(a) {
    const sawDone = a.address === this.held?.address && this.held.rank === RANK.done && a.status === "idle";
    return sawDone ? RANK.done : RANK[a.status] ?? 0;
  }

  sortMenu() {
    const on = sortOf().id, p = lcd(false);
    return v_flex()
      .size_full()
      .p(5)
      .gap(4)
      .bg(p.bg)
      .border(3)
      .border_color(p.edge)
      .font_family(MONO)
      .child(div().px(4).pt(2).pb(2).text_size(9.5).font_black().text_color(p.fg).child("SORT AGENTS"))
      .children(SORTS.map((s) => {
        const sel = s.id === on, ink = sel ? p.bg : p.fg;
        return h_flex()
          .id(`sort-${s.id}`)
          .h(28)
          .px(8)
          .gap(9)
          .items_center()
          .border(2)
          .border_color(p.fg)
          .bg(sel ? p.fg : "#00000000")
          .text_size(10.5)
          .font_black()
          .text_color(ink)
          .cursor_pointer()
          .hover((el) => el.bg(sel ? p.fg : p.fg + "26"))
          .on_click(() => {
            setShared("agents.sort", s.id);
            closeOverlay(props().overlay);
          })
          .child(svg(`mods/workspace-chrome/${s.icon}.svg`).size(13).flex_none().text_color(ink))
          .child(div().flex_1().child(s.label.toUpperCase()))
          .when(sel, (el) => el.child(svg("mods/workspace-chrome/check.svg").size(13).flex_none().text_color(ink)));
      }));
  }

  peek(addr) {
    run("terminal.peek", { terminal: addr });
  }

  // Live sub-agents of `addr`, depth first, each with the tree lines in front of it.
  tree(all, addr, lead = []) {
    const kids = all.filter((k) => k.parent === addr && k.state === "live");
    return kids.flatMap((k, i) => {
      const last = i === kids.length - 1;
      return [
        { t: k, lines: [...lead, last ? "└" : "├"] },
        ...this.tree(all, k.address, [...lead, last ? "" : "│"]),
      ];
    });
  }

  subRow(t, s, shown, compact) {
    const k = s.t;
    const st = kidStatus(k, this.listed);
    const pic = avatar(k.address, 2, st, this.tick);
    const on = k.address === shown;
    const p = on ? invert(this.p) : this.p;
    return h_flex()
      .id(`sub-${k.address}`)
      .pl(33)
      .pr(6)
      .h(26)
      .flex_none()
      .gap(0)
      .items_center()
      .text_size(10.5)
      .font_family(MONO)
      .font_bold()
      .when(on, (el) => el.bg(p.bg))
      .hover((s) => s.bg(on ? p.bg : p.fg + "26"))
      .on_click(() => this.peek(k.address))
      .children(s.lines.map(l => div().self_start().mt(-4).w(9).h(17).mr(4).flex_none()
        .when(Boolean(l), el => el.border_l(2).border_color(p.fg))
        .when(l === "└" || l === "├", el => el.border_b(2))))
      .when(Boolean(pic), el => el.child(div().mr(8).child(pic)))
      .child(div().flex_1().truncate().text_color(on ? p.fg : p.mute).child(String(k.name || k.template || k.program?.name || k.address).toUpperCase()))
      .child(this.status({ status: st }, compact, p));
  }

  // Status marks in LCD ink, told apart by shape: working a pulsing block, idle a hollow square, done a solid
  // one, blocked a blinking NEEDS YOU stamp (compact: a ! where a header already says "Needs you").
  status(a, compact = false, p = this.p) {
    if (a.status === "working") return div().size(8).mx(3).flex_none().bg(p.fg).loop("opacity", { from: 0.25, to: 1, period: 800 });
    if (a.status === "blocked" && compact) return div().size(14).flex_none().bg(p.fg).text_size(10).font_family(MONO).font_black().text_color(p.bg).flex().items_center().justify_center().loop("opacity", { from: 0.2, to: 1, period: 650 }).child("!");
    if (a.status === "blocked") return div().flex_none().px(5).h(16).bg(p.fg).text_size(9.5).font_family(MONO).font_black().text_color(p.bg).flex().items_center().loop("opacity", { from: 0.2, to: 1, period: 650 }).child("NEEDS YOU");
    if (a.status === "idle") return div().size(8).mx(3).flex_none().border(2).border_color(p.fg);
    return div().size(8).mx(3).flex_none().when(a.status === "done", (el) => el.bg(p.fg));
  }

  render(cx) {
    const t = theme();
    if (props()?.sortMenu) return this.sortMenu();
    const collapsed = narrow();
    const sort = sortOf();
    const everyone = agents();
    // The screen turns rust while any agent (sub-agents included) needs you, as the Metrics box does.
    const needs = everyone.filter((a) => a.status === "blocked").length;
    const p = (this.p = lcd(needs > 0));
    let list = everyone;
    this.listed = new Map(list.map((a) => [a.address, a.status]));
    const all = terminals();
    // One row per agent: a sub-agent that is also in agents() shows only nested
    // under its parent, not again as a top-level row.
    const nested = new Set(list.flatMap((a) => this.tree(all, a.address).map((s) => s.t.address)));
    list = list.filter((a) => !nested.has(a.address));
    this.anim = all.some((x) => x.state === "live" && animated(x.status));
    this.migratePins(all);
    const shown = focused()?.agent;
    const now = Date.now();
    this.track(list, now);
    this.hold(list);
    const byPriority = sort.id === "priority";
    const urgency = new Map(list.map((a) => [a.address, Math.max(this.rank(a), ...this.tree(all, a.address).map((s) => RANK[kidStatus(s.t, this.listed)] ?? 0))]));
    const rankOf = (a) => urgency.get(a.address);
    if (byPriority) list = [...list].sort((x, y) => rankOf(y) - rankOf(x) || this.since(y) - this.since(x) || y.seq - x.seq);
    // Agents with sub-agents come first, nested; the loose ones follow.
    const hasKids = (a) => (this.tree(all, a.address).length ? 0 : 1);
    const byKids = (x, y) => hasKids(x) - hasKids(y);
    const pinned = list.filter((a) => a.pinned).sort(byKids);
    const rest = list.filter((a) => !a.pinned).sort(byKids);
    list = [...pinned, ...rest];
    // Keyboard order still reaches nested agents, right after their parent.
    const known = new Set(everyone.map((a) => a.address));
    setAgentOrder(list.flatMap((a) => [a.address, ...this.tree(all, a.address).map((s) => s.t.address).filter((x) => known.has(x))]));

    const withKids = (a, i) => {
      const subs = collapsed ? [] : this.tree(all, a.address);
      const r = row(a, i, subs);
      if (this.folded.has(a.address)) return [r];
      return [r, ...subs.map((s) => this.subRow(t, s, shown, byPriority))];
    };

    // The fold chevron; folded, the count too, colored by the most urgent one.
    const fold = (a, subs) => {
      const sts = subs.map((s) => kidStatus(s.t, this.listed));
      const top = sts.reduce((m, s) => ((RANK[s] ?? 0) > (RANK[m] ?? 0) ? s : m), null);
      const open = !this.folded.has(a.address);
      const q = a.focused ? invert(p) : p;
      return div()
        .id(`fold-${a.address}`)
        .h(18)
        .px(3)
        .gap(3)
        .flex()
        .items_center()
        .text_size(10.5)
        .font_family(MONO)
        .font_black()
        .text_color(q.fg)
        .when(!open && top === "blocked", (el) => el.loop("opacity", { from: 0.35, to: 1, period: 650 }))
        .cursor_pointer()
        .hover((s) => s.bg(q.fg).text_color(q.bg))
        .on_click((_e, cx) => {
          cx.stop_propagation();
          open ? this.folded.add(a.address) : this.folded.delete(a.address);
          cx.notify();
        })
        .child(svg(`mods/workspace-chrome/chevron-${open ? "down" : "right"}.svg`).size(11).flex_none())
        .when(!open, (el) => el.child(String(subs.length)));
    };

    // A row reads "space \u00b7 detail": the detail is a tab someone named or the
    // agent's own title, never an automatic tab number unless two rows would
    // otherwise read the same.
    const tabs = spaces().flatMap(s => s.tabs);
    const label = (a) => {
      const tab = tabs.find(tab => tab.id === a.tab);
      return tab ? title(tab, lead(tab)) : a.title || a.program?.name || "";
    };
    const detail = new Map(list.map(a => [a.address, /^\d+$/.test(label(a)) ? null : label(a)]));
    const seen = {};
    for (const a of list) { const k = `${a.space_name}\u0000${detail.get(a.address) ?? ""}`; seen[k] = (seen[k] ?? 0) + 1; }
    for (const a of list) {
      if (detail.get(a.address) == null && seen[`${a.space_name}\u0000`] > 1) detail.set(a.address, label(a));
    }

    const row = (a, i, subs = []) => {
      const pic = avatar(a.address, 2, a.status, this.tick);
      const more = detail.get(a.address);
      // An agent on another machine (`vps/t7`) says which.
      const machine = a.address.includes("/") ? a.address.split("/")[0] : null;
      // The focused row is drawn inverted: ink block, screen-colored text.
      const q = a.focused ? invert(p) : p;
      if (collapsed) {
        return h_flex()
          .id(`ag-${a.address}`)
          .h(26)
          .px(2)
          .flex_none()
          .items_center()
          .gap(2)
          .when(a.focused, (el) => el.bg(q.bg))
          .hover((s) => s.bg(a.focused ? q.bg : p.fg + "26"))
          .on_click(() => run("pane.focus", { pane: a.pane }))
          .child(div().flex_1().min_w(0).whitespace_nowrap().text_right().text_size(10.5).font_family(MONO).font_black().text_color(q.fg).child(String(i + 1)))
          .child(h_flex().w(14).flex_none().items_center().justify_center().child(this.status(a, true, q)));
      }
      const when = this.since(a);
      const idle = a.status === "idle" && !a.focused;
      const isPinned = a.pinned;
      const pin = div()
        .id(`pin-${a.address}`)
        .flex_none()
        .p(2)
        .text_color(q.fg)
        .cursor_pointer()
        .hover((s) => s.bg(q.fg).text_color(q.bg))
        .tooltip(isPinned ? "Unpin" : "Pin to the top")
        .on_click((_e, cx) => {
          cx.stop_propagation();
          run("terminal.pin", { terminal: a.address, pinned: !isPinned });
          // The row moves away from under the pointer, and no hover-out comes.
          this.hovered = null;
          cx.notify();
        })
        .child(svg(`mods/workspace-chrome/${isPinned ? "pin-off" : "pin"}.svg`).size(13));
      // Under a space header the space goes without saying; an automatic tab number says nothing.
      // Without a space header above (priority, pinned) the row names its space.
      const full = byPriority || isPinned;
      const name = full ? a.space_name || label(a) : more ?? (/^\d+$/.test(label(a)) ? a.program?.name || label(a) : label(a));
      return h_flex()
        .id(`ag-${a.address}`)
        .px(6)
        .h(30)
        .flex_none()
        .relative()
        .items_center()
        .gap(8)
        .font_family(MONO)
        .when(a.focused, (el) => el.bg(q.bg))
        .when(a.status === "working", (el) => el.child(rainbowEdge(this.tick)))
        .cursor_pointer()
        .hover((s) => s.bg(a.focused ? q.bg : p.fg + "26"))
        .on_hover((on, cx) => {
          if (on) this.hovered = a.address;
          else if (this.hovered === a.address) this.hovered = null;
          cx.notify();
        })
        .on_click(() => run("pane.focus", { pane: a.pane }))
        .when(Boolean(pic), el => el.child(div().id(`agent-fold-${a.address}`)
          .when(subs.length > 0, el => el.on_click((_e, cx) => {
            cx.stop_propagation();
            this.folded.has(a.address) ? this.folded.delete(a.address) : this.folded.add(a.address);
            cx.notify();
          })).child(pic)))
        .child(h_flex().flex_1().min_w(0).gap(5).items_center()
          .child(div().min_w(0).max_w(full && more ? 120 : 200).truncate().text_size(11.5).font_black().text_color(idle ? q.mute : q.fg).child(String(name).toUpperCase()))
          .when(full && Boolean(more), el => el.child(div().flex_1().min_w(0).truncate().text_size(10.5).font_bold().text_color(q.mute).child(`\u00b7 ${String(more).toUpperCase()}`))))
        .when(Boolean(machine), el => el.child(div().text_size(9.5).font_bold().text_color(q.mute).child(machine.toUpperCase())))
        .when(subs.length > 0, el => el.child(fold(a, subs)))
        .when(this.hovered === a.address, el => el.child(pin))
        .when(this.hovered !== a.address && Boolean(when), el => el.child(div().flex_none().text_size(10).font_bold().text_color(q.fg).child(duration(now - when).toUpperCase())))
        .child(this.status(a, byPriority && !isPinned, q));
    };

    // Groups in list order: spaces (grouped) or priority sections. Agents of a
    // space are next to each other in agents(), so neighbours make a group.
    const groups = pinned.length ? [{ id: "pinned", label: "Pinned", status: null, members: pinned }] : [];
    for (const a of rest) {
      const r = rankOf(a) || RANK.idle;
      const id = byPriority ? `sec-${r}` : `sp-${a.space}`;
      if (groups.at(-1)?.id === id) groups.at(-1).members.push(a);
      else groups.push({ id, label: byPriority ? SECTION[r] : a.space_name || "", status: byPriority ? SECTION_STATUS[r] : null, members: [a] });
    }

    // A group's header; it folds the group. Folded, it says how many and the most urgent state.
    const header = (g) => {
      const open = !this.folded.has(g.id);
      const top = g.members.reduce((m, a) => ((RANK[a.status] ?? 0) > (RANK[m] ?? 0) ? a.status : m), null);
      return h_flex()
        .id(g.id)
        .px(6)
        .pt(6)
        .h(26)
        .flex_none()
        .gap(6)
        .items_center()
        .text_size(9.5)
        .font_family(MONO)
        .font_black()
        .text_color(p.fg)
        .cursor_pointer()
        .hover((s) => s.text_color(p.mute))
        .on_click((_e, cx) => {
          open ? this.folded.add(g.id) : this.folded.delete(g.id);
          cx.notify();
        })
        .child(div().truncate().when(g.status === "blocked", (el) => el.loop("opacity", { from: 0.35, to: 1, period: 650 })).child(String(g.label).toUpperCase()))
        .when(byPriority || !open, (el) => el.child(div().px(4).border(1).border_color(p.fg).child(String(g.members.length))))
        .child(div().flex_1())
        .when(!open, (el) => el
          .when(!byPriority && top && top !== "idle", (el) => el.child(this.status({ status: top }, true)))
          .child(svg("mods/workspace-chrome/chevron-right.svg").size(11).flex_none().text_color(p.fg)));
    };
    // Groups are split by a 2px ink rule across the screen, like the Metrics box's rows.
    const rows = collapsed
      ? list.flatMap(withKids)
      : groups.flatMap((g, gi) => [...(gi > 0 ? [div().id(`div-${g.id}`).h(2).mt(6).flex_none().bg(p.fg)] : []), header(g), ...(this.folded.has(g.id) ? [] : g.members.flatMap(withKids))]);

    const working = everyone.filter((a) => a.status === "working").length;
    const headline = list.length === 0 ? "NO AGENTS" : working > 0 ? `${working} WORKING` : "ALL IDLE";
    return v_flex()
      .size_full()
      .min_h(0)
      .bg(t.chrome)
      .border_t(1)
      .border_color(t.border)
      .p(collapsed ? 4 : 8)
      .child(v_flex()
        .flex_1()
        .min_h(0)
        .border(collapsed ? 2 : 3)
        .border_color(p.edge)
        .bg(p.bg)
        .font_family(MONO)
        // Title strip: AGENTS, the headline and the NEEDS YOU chip, the sort button boxed like the play button.
        .when(!collapsed, (el) =>
          el.child(
            h_flex()
              .px(10)
              .h(30)
              .flex_none()
              .gap(8)
              .items_center()
              .border_b(2)
              .border_color(p.fg)
              .child(div().flex_none().text_size(11).font_black().text_color(p.fg).child("AGENTS"))
              .child(div().flex_1().min_w(0).truncate().text_size(9.5).font_bold().text_color(p.fg).child(headline))
              .when(needs > 0, (el) => el.child(div().flex_none().px(5).bg(p.fg).text_size(9.5).font_black().text_color(p.bg)
                .loop("opacity", { from: 0.25, to: 1, period: 650 }).child(`${needs} NEEDS YOU`)))
              .child(
                div()
                  .id("ag-sort")
                  .flex_none()
                  .w(22)
                  .h(18)
                  .flex()
                  .items_center()
                  .justify_center()
                  .border(2)
                  .border_color(p.fg)
                  .text_color(p.fg)
                  .cursor_pointer()
                  .hover((s) => s.bg(p.fg).text_color(p.bg))
                  .on_click(() => openOverlay({ mod: "agents-metrics", kind: "popup", width: 200, height: 140, props: { sortMenu: true } }))
                  .tooltip(`Sort agents: ${sort.label}`)
                  .child(svg(`mods/workspace-chrome/${sort.icon}.svg`).size(11)),
              ),
          ),
        )
        .when(list.length === 0 && !collapsed, (el) =>
          el.child(div().px(10).py(8).text_size(10.5).font_bold().text_color(p.fg).child("NO AGENT STATUS YET. AGENTS SHOW UP HERE WHEN THEY REPORT THEIR STATUS. OLDER VERSIONS AND AGENTS INSIDE TMUX MAY NOT.")),
        )
        .child(v_flex().id("ag-list").flex_1().min_h(0).px(collapsed ? 0 : 4).pb(4).overflow_y_scrollbar().mode("always").children(rows))
        .when(collapsed, (el) =>
          el.child(
            h_flex()
              .h(28)
              .flex_none()
              .items_center()
              .justify_center()
              .border_t(2)
              .border_color(p.fg)
              .child(
                div()
                  .id("collapse")
                  .px(4)
                  .text_size(13)
                  .font_black()
                  .text_color(p.fg)
                  .cursor_pointer()
                  .hover((s) => s.bg(p.fg).text_color(p.bg))
                  .on_click(toggleSidebar)
                  .child("»"),
              ),
          ),
        ),
      );
  }
}
