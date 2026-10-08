/* Podium frontend — zero deps, hash-routed single page. */
(function () {
"use strict";

var reducedMotion = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

/* ---------- utils ---------- */
function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
  });
}
function money(cents) {
  var n = Number(cents) || 0;
  return "$" + (n / 100).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}
function fmtHours(h) { return (Math.round(Number(h) * 100) / 100) + "h"; }
function dayLabel(iso) {
  var d = new Date(iso + "T12:00:00");
  return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d.getDay()] + " " + d.getDate();
}
function todayIso() {
  var d = new Date();
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
}
function mondayOf(iso) {
  var d = iso ? new Date(iso + "T12:00:00") : new Date();
  var dow = (d.getDay() + 6) % 7;
  d.setDate(d.getDate() - dow);
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
}
function addDays(iso, n) {
  var d = new Date(iso + "T12:00:00");
  d.setDate(d.getDate() + n);
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
}
function timeAgo(iso) {
  var s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return Math.floor(s / 60) + "m ago";
  if (s < 86400) return Math.floor(s / 3600) + "h ago";
  return Math.floor(s / 86400) + "d ago";
}

/* ---------- tiny markdown ---------- */
function md(src) {
  var lines = esc(src).split("\n");
  var html = "", inList = false, inCode = false, para = [];
  function inline(t) {
    return t
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/\*([^*]+)\*/g, "<em>$1</em>")
      .replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  }
  function flushPara() {
    if (para.length) { html += "<p>" + para.map(inline).join("<br>") + "</p>"; para = []; }
  }
  lines.forEach(function (ln) {
    if (/^```/.test(ln)) { flushPara(); if (inList) { html += "</ul>"; inList = false; } html += inCode ? "</pre>" : "<pre>"; inCode = !inCode; return; }
    if (inCode) { html += ln + "\n"; return; }
    var h = ln.match(/^(#{1,3})\s+(.*)/);
    if (h) { flushPara(); if (inList) { html += "</ul>"; inList = false; } html += "<h3>" + inline(h[2]) + "</h3>"; return; }
    if (/^\s*>\s?/.test(ln)) { flushPara(); if (inList) { html += "</ul>"; inList = false; } html += "<blockquote>" + inline(ln.replace(/^\s*>\s?/, "")) + "</blockquote>"; return; }
    if (/^\s*[-*]\s+/.test(ln)) { flushPara(); if (!inList) { html += "<ul>"; inList = true; } html += "<li>" + inline(ln.replace(/^\s*[-*]\s+/, "")) + "</li>"; return; }
    if (/^\s*$/.test(ln)) { flushPara(); if (inList) { html += "</ul>"; inList = false; } return; }
    para.push(ln);
  });
  flushPara();
  if (inList) html += "</ul>";
  if (inCode) html += "</pre>";
  return html;
}

/* ---------- api ---------- */
function api(method, path, body) {
  return fetch(path, {
    method: method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  }).then(function (r) {
    if (!r.ok) return r.json().catch(function () { return { error: "request failed" }; }).then(function (j) {
      throw new Error(j.error || ("HTTP " + r.status));
    });
    var ct = r.headers.get("content-type") || "";
    return ct.indexOf("application/json") >= 0 ? r.json() : r.text();
  });
}

/* ---------- state ---------- */
var state = {
  people: [], pods: [],
  pod: null, members: [], channels: [], channel: null, messages: [], pages: [], page: null,
  replyTo: null, editingPage: false,
  timePerson: null, timeWeek: mondayOf(), entries: [],
  periods: [], period: null,
  err: "", okMsg: "",
};
function setErr(m) { state.err = m; state.okMsg = ""; render(); if (!reducedMotion && typeof document !== "undefined") window.scrollTo(0, 0); }
function setOk(m) { state.okMsg = m; state.err = ""; render(); }

/* ---------- router ---------- */
function route() {
  var h = (location.hash || "#/home").replace(/^#/, "");
  var parts = h.split("/").filter(Boolean);
  state.err = ""; state.okMsg = "";
  state.replyTo = null; state.editingPage = false; state.page = null;
  var v = parts[0] || "home";
  if (v === "home") return loadHome();
  if (v === "pods") return loadPods();
  if (v === "pod" && parts[1]) return loadPod(parts[1], parts[2] || "channels");
  if (v === "people") return loadPeople();
  if (v === "payroll") return loadPayroll(parts[1] || null);
  return loadHome();
}

/* ---------- data loaders ---------- */
function loadHome() {
  Promise.all([api("GET", "/api/dashboard"), api("GET", "/api/pods"), api("GET", "/api/people")])
    .then(function (r) { state.dash = r[0]; state.pods = r[1].pods; state.people = r[2].people; render(); })
    .catch(function (e) { setErr(e.message); });
}
function loadPods() {
  api("GET", "/api/pods").then(function (r) { state.pods = r.pods; render(); }).catch(function (e) { setErr(e.message); });
}
function loadPod(id, tab) {
  state.podTab = tab;
  api("GET", "/api/pods/" + id).then(function (r) {
    state.pod = r.pod; state.members = r.members; state.channels = r.channels;
    if (tab === "channels") {
      var cid = state.channel && r.channels.some(function (c) { return c.id === state.channel.id; })
        ? state.channel.id : (r.channels[0] && r.channels[0].id);
      if (!cid) { state.messages = []; render(); return; }
      state.channel = r.channels.find(function (c) { return c.id === cid; });
      api("GET", "/api/channels/" + cid + "/messages").then(function (m) { state.messages = m.messages; render(); });
    } else if (tab === "pages") {
      api("GET", "/api/pods/" + id + "/pages").then(function (p) { state.pages = p.pages; render(); });
    } else if (tab === "time") {
      loadTimeTab();
      return;
    }
    render();
  }).catch(function (e) { setErr(e.message); });
}
function loadTimeTab() {
  var pid = state.timePerson || (state.members[0] && state.members[0].person_id);
  state.timePerson = pid;
  if (!pid) { state.entries = []; render(); return; }
  var from = state.timeWeek, to = addDays(state.timeWeek, 6);
  api("GET", "/api/time?person_id=" + pid + "&from=" + from + "&to=" + to)
    .then(function (r) { state.entries = r.entries; render(); })
    .catch(function (e) { setErr(e.message); });
}
function loadPeople() {
  var week = mondayOf();
  Promise.all([api("GET", "/api/people"), api("GET", "/api/dashboard"), api("GET", "/api/time?week=" + week)])
    .then(function (r) {
      state.people = r[0].people; state.dash = r[1];
      var wh = {};
      r[2].entries.forEach(function (e) { wh[e.person_id] = (wh[e.person_id] || 0) + Number(e.hours); });
      state.weekHours = wh;
      render();
    })
    .catch(function (e) { setErr(e.message); });
}
function loadPayroll(periodId) {
  api("GET", "/api/periods").then(function (r) {
    state.periods = r.periods;
    if (periodId) {
      return api("GET", "/api/periods/" + periodId).then(function (p) { state.period = p; render(); });
    }
    state.period = null; render();
  }).catch(function (e) { setErr(e.message); });
}

/* ---------- chrome ---------- */
function renderSidebar() {
  var pods = state.pods.map(function (p) {
    return '<a class="nav-item' + (state.pod && state.pod.id === p.id ? " active" : "") + '" href="#/pod/' + p.id + '/channels">' +
      '<span class="dot" style="background:' + esc(p.color) + '"></span>' + esc(p.name) +
      '<span class="nav-count">' + p.members + '</span></a>';
  }).join("");
  return '<div class="brand">Podium<span>.</span></div>' +
    '<div class="nav-sec">Firm</div>' +
    '<a class="nav-item" href="#/home">Dashboard</a>' +
    '<a class="nav-item" href="#/people">People</a>' +
    '<a class="nav-item" href="#/payroll">Payroll</a>' +
    '<div class="nav-sec">Pods</div>' + (pods || '<div class="muted" style="padding:0 10px">No pods yet</div>') +
    '<div style="padding:12px 10px"><a class="link-btn" href="#/pods">Manage pods</a></div>';
}
function flash() {
  var h = "";
  if (state.err) h += '<div class="err">' + esc(state.err) + '</div>';
  if (state.okMsg) h += '<div class="ok-msg">' + esc(state.okMsg) + '</div>';
  return h;
}

/* ---------- views (pure: data in, html out) ---------- */
function viewHome(d) {
  d = d || { hoursPerPod: [], openPeriod: null, openPeriodPerPerson: [], week: {} };
  var max = Math.max.apply(null, [0].concat(d.hoursPerPod.map(function (r) { return Number(r.hours); })));
  var bars = d.hoursPerPod.map(function (r) {
    var w = max ? Math.round(Number(r.hours) / max * 100) : 0;
    return '<div class="bar-row"><div class="bar-label">' + esc(r.pod_name) + '</div>' +
      '<div class="bar-track"><div class="bar-fill" style="width:' + w + '%;background:' + esc(r.color || "#c96f4a") + '"></div></div>' +
      '<div class="bar-val">' + fmtHours(r.hours) + '</div></div>';
  }).join("") || '<div class="empty">No hours logged this week yet.</div>';
  var per = d.openPeriodPerPerson.map(function (r) {
    return '<div class="bar-row"><div class="bar-label">' + esc(r.person_name) + '</div>' +
      '<div class="bar-track"><div class="bar-fill" style="width:100%;background:#8a8175"></div></div>' +
      '<div class="bar-val">' + fmtHours(r.hours) + '</div></div>';
  }).join("");
  return '<div class="view-head"><h1>Dashboard</h1><span class="sub">Week of ' + esc(d.week.from || "") + '</span></div>' + flash() +
    '<div class="card"><h3>Hours this week, by pod</h3>' + bars + '</div>' +
    '<div class="card"><h3>Open pay period' + (d.openPeriod ? ' — ' + esc(d.openPeriod.label) : '') + '</h3>' +
    (d.openPeriod ? (per || '<div class="empty">No entries in this period yet.</div>') : '<div class="empty">No open period. Create one under Payroll.</div>') + '</div>';
}

function viewPods(pods) {
  var cards = pods.map(function (p) {
    return '<div class="card pod-card" onclick="location.hash=\'#/pod/' + p.id + '/channels\'">' +
      '<div class="row"><span class="dot" style="background:' + esc(p.color) + ';width:14px;height:14px"></span>' +
      '<span class="name">' + esc(p.name) + '</span></div>' +
      '<div class="client">' + esc(p.client_name || "No client set") + '</div>' +
      '<div class="stat"><b>' + p.members + '</b> members · <b>' + (p.channels || 0) + '</b> channels</div></div>';
  }).join("");
  return '<div class="view-head"><h1>Pods</h1><span class="sub">Intimate teams, under ten</span></div>' + flash() +
    '<div class="grid two">' + cards + '</div>' +
    '<div class="card"><h3>New pod</h3>' +
    '<form onsubmit="return Podium.createPod(event)"><div class="form-row">' +
    '<input name="name" placeholder="Pod name" required maxlength="60">' +
    '<input name="client_name" placeholder="Client company" maxlength="80">' +
    '<input name="color" type="color" value="#c96f4a" style="max-width:70px" title="Pod color">' +
    '</div><div style="margin-top:10px"><button class="btn" type="submit">Create pod</button></div></form></div>';
}

function viewPodHead(pod, tab, members) {
  var tabs = [["channels", "Channels"], ["pages", "Pages"], ["time", "Time"]].map(function (t) {
    return '<div class="tab' + (tab === t[0] ? " active" : "") + '" onclick="location.hash=\'#/pod/' + pod.id + '/' + t[0] + '\'">' + t[1] + "</div>";
  }).join("");
  var mem = members.map(function (m) {
    return '<span class="pill" style="background:var(--sand);margin:2px 4px 2px 0" title="' + esc(m.role || "member") + '">' +
      esc(m.person_name) + ' <a href="#" onclick="return Podium.removeMember(\'' + pod.id + "','" + m.person_id + '\')" style="color:var(--muted);text-decoration:none" title="Remove">×</a></span>';
  }).join("");
  return '<div class="view-head"><span class="dot" style="background:' + esc(pod.color) + ';width:16px;height:16px"></span>' +
    '<h1>' + esc(pod.name) + '</h1><span class="sub">' + esc(pod.client_name || "") + ' · ' + members.length + '/9 members</span></div>' + flash() +
    '<div class="card"><h3>Members</h3><div>' + (mem || '<span class="muted">No members yet — add the pod\'s execs below.</span>') + '</div>' +
    '<form onsubmit="return Podium.addMember(event,\'' + pod.id + '\')" style="margin-top:10px"><div class="form-row">' +
    '<select name="person_id" id="member-picker" required></select>' +
    '<input name="role" placeholder="Role in pod (e.g. Lead)" maxlength="40">' +
    '</div><div style="margin-top:10px"><button class="btn small" type="submit">Add member</button></div></form></div>' +
    '<div class="tabs">' + tabs + '</div>';
}

function viewChannels(channels, activeId, messages, replyTo, members, podId) {
  var list = channels.map(function (c) {
    return '<div class="chan-item' + (c.id === activeId ? " active" : "") + '" onclick="Podium.switchChannel(\'' + c.id + '\')"># ' + esc(c.name) + '</div>';
  }).join("");
  var msgs = messages.map(function (m) { return renderMessage(m); }).join("") ||
    '<div class="empty">Quiet in here. Say hello.</div>';
  var banner = replyTo
    ? '<div class="thread-banner">Replying in thread <button class="link-btn" onclick="Podium.cancelReply()">cancel</button></div>' : "";
  var lastAuthor = "";
  try { lastAuthor = localStorage.getItem("podium_author_" + podId) || ""; } catch (e) {}
  var authors = (members || []).map(function (m) {
    var sel = (m.person_id === lastAuthor || (!lastAuthor && m === members[0])) ? " selected" : "";
    return '<option value="' + m.person_id + '"' + sel + '>' + esc(m.person_name) + '</option>';
  }).join("");
  return '<div class="chat-wrap"><div class="chan-list">' + list +
    '<div style="padding:8px 4px"><button class="link-btn" onclick="Podium.newChannel()">+ New channel</button></div></div>' +
    '<div class="msg-pane card">' + msgs +
    '<form class="compose" onsubmit="return Podium.sendMessage(event)">' + banner +
    '<select name="author_id" id="compose-author" style="max-width:130px;flex-shrink:0">' + authors + '</select>' +
    '<input name="body" id="compose-box" placeholder="Message #' + esc((channels.find(function (c) { return c.id === activeId; }) || { name: "" }).name) + '" autocomplete="off">' +
    '<button class="btn" type="submit">Send</button></form></div></div>';
}
function renderMessage(m) {
  var replies = (m.replies || []).map(function (r) {
    return '<div class="msg"><div class="msg-head"><span class="msg-author">' + esc(r.author_name || "Unknown") +
      '</span><span class="msg-time">' + timeAgo(r.created_at) + '</span></div><div class="msg-body">' + md(r.body_md) + '</div></div>';
  }).join("");
  return '<div class="msg" id="msg-' + m.id + '"><div class="msg-head"><span class="msg-author">' +
    esc(m.author_name || "Unknown") + '</span><span class="msg-time">' + timeAgo(m.created_at) + '</span></div>' +
    '<div class="msg-body">' + md(m.body_md) + '</div>' +
    (replies ? '<div class="thread">' + replies + '</div>' : "") +
    '<div><span class="reply-link" onclick="Podium.startReply(\'' + m.id + '\')">Reply in thread</span></div></div>';
}

function viewPages(pages, editing, page) {
  var list = pages.map(function (p) {
    return '<div class="page-item" onclick="Podium.openPage(\'' + p.id + '\')"><div class="t">' + esc(p.title) +
      '</div><div class="m">Updated ' + timeAgo(p.updated_at) + (p.updated_by ? ' by ' + esc(p.updated_by) : '') + '</div></div>';
  }).join("") || '<div class="empty">No pages yet — start the pod wiki.</div>';
  var main;
  if (editing) {
    main = '<div class="card"><h3>' + (page ? "Edit page" : "New page") + '</h3>' +
      '<form onsubmit="return Podium.savePage(event)">' +
      '<label>Title</label><input name="title" value="' + esc(page ? page.title : "") + '" required maxlength="120">' +
      '<label>Body (markdown)</label><div class="editor-split"><textarea name="body_md" id="page-src" oninput="Podium.previewPage()">' +
      esc(page ? page.body_md : "") + '</textarea><div class="preview" id="page-preview"></div></div>' +
      '<div style="margin-top:10px;display:flex;gap:8px"><button class="btn" type="submit">Save</button>' +
      '<button class="btn ghost" type="button" onclick="Podium.cancelPageEdit()">Cancel</button>' +
      (page ? '<button class="btn danger" type="button" onclick="Podium.deletePage(\'' + page.id + '\')">Delete</button>' : '') + '</div></form></div>';
  } else if (page) {
    main = '<div class="card"><div class="view-head"><h1 style="font-size:20px">' + esc(page.title) + '</h1>' +
      '<span class="sub">' + timeAgo(page.updated_at) + (page.updated_by ? ' · ' + esc(page.updated_by) : '') + '</span>' +
      '<span style="flex:1"></span><button class="btn small ghost" onclick="Podium.editPage()">Edit</button> ' +
      '<button class="btn small ghost" onclick="Podium.closePage()">All pages</button></div>' +
      '<div class="msg-body">' + md(page.body_md) + '</div></div>';
  } else {
    main = '<div class="card"><div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">' +
      '<h3 style="margin:0">Wiki</h3><button class="btn small" onclick="Podium.newPage()">+ New page</button></div>' + list + '</div>';
  }
  return main;
}

function viewTimeTab(pod, members, people, personId, week, entries) {
  var opts = members.map(function (m) {
    var p = people.find(function (x) { return x.id === m.person_id; });
    return '<option value="' + m.person_id + '"' + (m.person_id === personId ? " selected" : "") + '>' + esc(p ? p.name : m.person_name) + '</option>';
  }).join("");
  var days = [0, 1, 2, 3, 4, 5, 6].map(function (i) { return addDays(week, i); });
  var byDayPod = {};
  entries.forEach(function (e) {
    var k = e.day + "|" + e.pod_id;
    byDayPod[k] = (byDayPod[k] || 0) + Number(e.hours);
  });
  // rows: this pod only in pod context
  var rows = "";
  if (state.pod) {
    var cells = days.map(function (d) {
      var h = byDayPod[d + "|" + state.pod.id] || 0;
      return '<td class="tg-cell" onclick="Podium.quickEntry(\'' + d + '\')">' + (h ? fmtHours(h) : '<span class="muted">–</span>') + '</td>';
    }).join("");
    rows = '<tr><td><span class="dot" style="background:' + esc(state.pod.color) + ';display:inline-block;margin-right:6px"></span>' + esc(state.pod.name) + '</td>' + cells + '</tr>';
  }
  var head = days.map(function (d) { return "<th>" + dayLabel(d) + "</th>"; }).join("");
  var list = entries.map(function (e) {
    return '<tr><td>' + esc(e.day) + '</td><td>' + esc(e.pod_name || "") + '</td><td class="num">' + fmtHours(e.hours) + '</td>' +
      '<td>' + (e.billable ? '<span class="pill billable">billable</span>' : '<span class="pill nonbill">non-billable</span>') + '</td>' +
      '<td>' + esc(e.note || "") + '</td>' +
      '<td><button class="link-btn" onclick="Podium.editEntry(\'' + e.id + '\')">Edit</button> ' +
      '<button class="link-btn" onclick="Podium.deleteEntry(\'' + e.id + '\')">Delete</button></td></tr>';
  }).join("");
  return '<div class="card"><h3>Time — week of ' + esc(week) + '</h3>' +
    '<div class="form-row" style="margin-bottom:10px;max-width:420px"><div><label>Person</label>' +
    '<select id="time-person" onchange="Podium.switchTimePerson(this.value)">' + opts + '</select></div>' +
    '<div><label>Week</label><input type="date" id="time-week" value="' + esc(week) + '" onchange="Podium.switchTimeWeek(this.value)"></div></div>' +
    '<div class="time-grid"><table class="tg-table"><tr><th>Pod</th>' + head + '</tr>' + (rows || '<tr><td colspan="8" class="muted">No pods</td></tr>') + '</table></div>' +
    '<div class="muted" style="margin-top:6px">Tap a day to log time.</div></div>' +
    '<div class="card"><h3>Log time</h3><form onsubmit="return Podium.saveEntry(event)">' +
    '<input type="hidden" name="id" id="entry-id"><div class="form-row">' +
    '<div><label>Day</label><input type="date" name="day" id="entry-day" value="' + esc(todayIso()) + '" required></div>' +
    '<div><label>Hours</label><input type="number" name="hours" id="entry-hours" step="0.25" min="0.25" max="24" required placeholder="4"></div>' +
    '<div><label>Billable</label><select name="billable" id="entry-billable"><option value="1">Billable</option><option value="0">Non-billable</option></select></div>' +
    '</div><label>Note</label><input name="note" id="entry-note" placeholder="What was this for?" maxlength="200">' +
    '<div style="margin-top:10px"><button class="btn" type="submit">Save entry</button> <button class="btn ghost" type="button" onclick="Podium.resetEntryForm()">Clear</button></div></form></div>' +
    '<div class="card"><h3>Entries</h3><table><tr><th>Day</th><th>Pod</th><th class="num">Hours</th><th>Type</th><th>Note</th><th></th></tr>' +
    (list || '<tr><td colspan="6" class="muted">No entries this week.</td></tr>') + '</table></div>';
}

function viewPeople(people, weekHours) {
  weekHours = weekHours || {};
  var rows = people.map(function (p) {
    var initials = p.name.split(/\s+/).map(function (w) { return w[0]; }).join("").slice(0, 2).toUpperCase();
    return '<div class="person-row"><div class="avatar">' + esc(initials) + '</div>' +
      '<div class="who"><div class="nm">' + esc(p.name) + '</div><div class="ti">' + esc(p.title || "—") + (p.email ? " · " + esc(p.email) : "") + '</div></div>' +
      '<div style="text-align:right"><div class="rate">' + money(p.hourly_rate_cents) + '/hr</div>' +
      '<div class="muted">' + fmtHours(weekHours[p.id] || 0) + ' this week</div></div>' +
      '<button class="link-btn" onclick="Podium.editPerson(\'' + p.id + '\')">Edit</button></div>';
  }).join("");
  return '<div class="view-head"><h1>People</h1><span class="sub">' + people.length + ' execs</span></div>' + flash() +
    '<div class="card">' + (rows || '<div class="empty">No people yet.</div>') + '</div>' +
    '<div class="card"><h3>Add person</h3><form onsubmit="return Podium.savePerson(event)">' +
    '<input type="hidden" name="id" id="person-id"><div class="form-row">' +
    '<div><label>Name</label><input name="name" id="person-name" required maxlength="60"></div>' +
    '<div><label>Title</label><input name="title" id="person-title" placeholder="Fractional CFO" maxlength="60"></div></div>' +
    '<div class="form-row"><div><label>Email</label><input name="email" id="person-email" type="email" maxlength="120"></div>' +
    '<div><label>Hourly rate (USD)</label><input name="rate" id="person-rate" type="number" min="0" step="1" placeholder="250"></div></div>' +
    '<div style="margin-top:10px"><button class="btn" type="submit">Save person</button> <button class="btn ghost" type="button" onclick="Podium.resetPersonForm()">Clear</button></div></form></div>';
}

function viewPayroll(periods, detail) {
  var open = periods.find(function (p) { return p.status === "open"; });
  var h = '<div class="view-head"><h1>Payroll</h1><span class="sub">Statements, not disbursement</span></div>' + flash();
  if (detail) {
    var p = detail.period;
    var live = p.status === "open" && (!detail.statements || !detail.statements.length) && detail.live;
    var rows = (live || detail.statements).map(function (s) {
      return '<tr><td>' + esc(s.person_name || s.person_id) + '</td><td>' + esc(s.pod_name || s.pod_id) + '</td>' +
        '<td class="num">' + fmtHours(s.hours) + '</td><td class="num">' + money(s.rate_cents) + '</td>' +
        '<td class="num"><b>' + money(s.amount_cents) + '</b></td></tr>';
    }).join("");
    var total = (live || detail.statements).reduce(function (a, s) { return a + s.amount_cents; }, 0);
    h += '<div class="card"><div class="view-head"><h1 style="font-size:20px">' + esc(p.label) + '</h1>' +
      '<span class="pill ' + p.status + '">' + p.status + '</span><span style="flex:1"></span>' +
      '<button class="btn small ghost" onclick="location.hash=\'#/payroll\'">All periods</button> ' +
      '<a class="btn small" href="/api/periods/' + p.id + '/export.csv">Download CSV</a></div>' +
      '<div class="muted">' + esc(p.start_day) + ' → ' + esc(p.end_day) + (p.closed_at ? ' · closed ' + timeAgo(p.closed_at) : '') +
      (live ? ' · <b>live preview</b> — what closing would snapshot' : '') + '</div>' +
      '<table style="margin-top:10px"><tr><th>Person</th><th>Pod</th><th class="num">Hours</th><th class="num">Rate</th><th class="num">Amount</th></tr>' +
      (rows || '<tr><td colspan="5" class="muted">No statements.</td></tr>') + '</table>' +
      '<div style="text-align:right;margin-top:10px;font-size:18px">Total <b>' + money(total) + '</b></div></div>';
    if (p.status === "open") {
      h += '<div class="card"><h3>Close this period</h3><p class="muted">Closing stamps every open entry in range and snapshots hours × each person\'s current rate. Entries become read-only.</p>' +
        '<button class="btn" onclick="Podium.closePeriod(\'' + p.id + '\')">Close period</button></div>';
    }
    return h;
  }
  var cards = periods.map(function (p) {
    return '<div class="page-item" onclick="location.hash=\'#/payroll/' + p.id + '\'"><div class="t">' + esc(p.label) +
      ' <span class="pill ' + p.status + '">' + p.status + '</span></div>' +
      '<div class="m">' + esc(p.start_day) + ' → ' + esc(p.end_day) + '</div></div>';
  }).join("") || '<div class="empty">No pay periods yet.</div>';
  h += '<div class="card"><div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px"><h3 style="margin:0">Pay periods</h3></div>' + cards + '</div>';
  if (!open) {
    h += '<div class="card"><h3>Open a period</h3><form onsubmit="return Podium.createPeriod(event)"><div class="form-row">' +
      '<div><label>Label</label><input name="label" required placeholder="October 2026" maxlength="60"></div>' +
      '<div><label>Start</label><input name="start_day" type="date" required></div>' +
      '<div><label>End</label><input name="end_day" type="date" required></div></div>' +
      '<div style="margin-top:10px"><button class="btn" type="submit">Open period</button></div></form></div>';
  } else {
    h += '<div class="card"><h3>Current open period</h3><div class="page-item" onclick="location.hash=\'#/payroll/' + open.id + '\'">' +
      '<div class="t">' + esc(open.label) + ' <span class="pill open">open</span></div>' +
      '<div class="m">' + esc(open.start_day) + ' → ' + esc(open.end_day) + ' — tap to review and close</div></div></div>';
  }
  h += '<div class="card"><h3>How payroll works here</h3><p class="muted">Podium calculates what each exec earned — hours × their rate at close — and exports a CSV for your payroll provider. <b>No money moves through Podium.</b> Self-hosted disbursement would be irresponsible to fake.</p></div>';
  return h;
}

/* ---------- render orchestration ---------- */
function currentView() {
  var h = (location.hash || "#/home").replace(/^#/, "");
  return (h.split("/").filter(Boolean)[0] || "home");
}
function render() {
  var v = currentView();
  document.getElementById("sidebar").innerHTML = renderSidebar();
  document.querySelectorAll("#bottomnav a").forEach(function (a) {
    a.classList.toggle("active", a.getAttribute("data-v") === v || (v === "pod" && a.getAttribute("data-v") === "pods"));
  });
  var el = document.getElementById("view");
  if (v === "home") el.innerHTML = viewHome(state.dash);
  else if (v === "pods") el.innerHTML = viewPods(state.pods);
  else if (v === "pod" && state.pod) {
    var tab = state.podTab || "channels";
    var head = viewPodHead(state.pod, tab, state.members);
    if (tab === "channels") el.innerHTML = head + viewChannels(state.channels, state.channel && state.channel.id, state.messages, state.replyTo, state.members, state.pod.id);
    else if (tab === "pages") el.innerHTML = head + viewPages(state.pages, state.editingPage, state.page);
    else if (tab === "time") el.innerHTML = head + viewTimeTab(state.pod, state.members, state.people, state.timePerson, state.timeWeek, state.entries);
    fillMemberPicker();
  }
  else if (v === "people") el.innerHTML = viewPeople(state.people, state.weekHours || {});
  else if (v === "payroll") el.innerHTML = viewPayroll(state.periods, state.period);
  else el.innerHTML = viewHome(state.dash);
  if (state.editingPage) Podium.previewPage();
}
function fillMemberPicker() {
  var sel = document.getElementById("member-picker");
  if (!sel || !state.people) return;
  var inPod = {};
  state.members.forEach(function (m) { inPod[m.person_id] = 1; });
  sel.innerHTML = state.people.filter(function (p) { return !inPod[p.id]; })
    .map(function (p) { return '<option value="' + p.id + '">' + esc(p.name) + '</option>'; }).join("") ||
    '<option value="">Everyone is already in this pod</option>';
}

/* ---------- actions ---------- */
var Podium = {
  md: md, esc: esc, money: money, fmtHours: fmtHours,
  viewHome: viewHome, viewPods: viewPods, viewPodHead: viewPodHead, viewChannels: viewChannels,
  renderMessage: renderMessage, viewPages: viewPages, viewTimeTab: viewTimeTab, viewPeople: viewPeople,
  viewPayroll: viewPayroll, renderSidebar: renderSidebar, mondayOf: mondayOf, addDays: addDays,

  createPod: function (e) {
    e.preventDefault();
    var f = e.target;
    api("POST", "/api/pods", { name: f.name.value, client_name: f.client_name.value, color: f.color.value })
      .then(function (r) { location.hash = "#/pod/" + r.pod.id + "/channels"; })
      .catch(function (er) { setErr(er.message); });
    return false;
  },
  addMember: function (e, podId) {
    e.preventDefault();
    var f = e.target;
    if (!f.person_id.value) { setErr("Everyone is already in this pod."); return false; }
    api("POST", "/api/pods/" + podId + "/members", { person_id: f.person_id.value, role: f.role.value })
      .then(function () { loadPod(podId, state.podTab || "channels"); })
      .catch(function (er) { setErr(er.message); });
    return false;
  },
  removeMember: function (podId, personId) {
    if (!confirm("Remove this member from the pod?")) return false;
    api("DELETE", "/api/pods/" + podId + "/members/" + personId)
      .then(function () { loadPod(podId, state.podTab || "channels"); })
      .catch(function (er) { setErr(er.message); });
    return false;
  },
  switchChannel: function (cid) {
    state.channel = state.channels.find(function (c) { return c.id === cid; });
    state.replyTo = null;
    api("GET", "/api/channels/" + cid + "/messages").then(function (m) { state.messages = m.messages; render(); });
  },
  newChannel: function () {
    var name = prompt("Channel name:");
    if (!name) return;
    api("POST", "/api/pods/" + state.pod.id + "/channels", { name: name })
      .then(function (r) { state.channels.push(r.channel); state.channel = r.channel; state.messages = []; render(); })
      .catch(function (e) { setErr(e.message); });
  },
  startReply: function (mid) {
    state.replyTo = mid;
    render();
    var box = document.getElementById("compose-box");
    if (box) box.focus();
  },
  cancelReply: function () { state.replyTo = null; render(); },
  sendMessage: function (e) {
    e.preventDefault();
    var body = e.target.body.value;
    if (!body.trim()) return false;
    var authorId = e.target.author_id.value;
    if (!authorId) { setErr("Add a member to the pod before chatting."); return false; }
    try { localStorage.setItem("podium_author_" + state.pod.id, authorId); } catch (err) {}
    api("POST", "/api/channels/" + state.channel.id + "/messages",
      { author_id: authorId, body_md: body, thread_parent_id: state.replyTo })
      .then(function () { state.replyTo = null; Podium.switchChannel(state.channel.id); })
      .catch(function (er) { setErr(er.message); });
    return false;
  },
  openPage: function (id) {
    api("GET", "/api/pages/" + id).then(function (r) { state.page = r.page; state.editingPage = false; render(); });
  },
  closePage: function () { state.page = null; state.editingPage = false; render(); },
  newPage: function () { state.page = null; state.editingPage = true; render(); },
  editPage: function () { state.editingPage = true; render(); },
  cancelPageEdit: function () { state.editingPage = false; render(); },
  previewPage: function () {
    var src = document.getElementById("page-src"), pv = document.getElementById("page-preview");
    if (src && pv) pv.innerHTML = md(src.value);
  },
  savePage: function (e) {
    e.preventDefault();
    var f = e.target;
    var author = (state.members[0] && state.members[0].person_name) || "";
    var p = state.page
      ? api("PUT", "/api/pages/" + state.page.id, { title: f.title.value, body_md: f.body_md.value, updated_by: author })
      : api("POST", "/api/pods/" + state.pod.id + "/pages", { title: f.title.value, body_md: f.body_md.value, updated_by: author });
    p.then(function (r) { state.page = r.page; state.editingPage = false; loadPod(state.pod.id, "pages"); })
      .catch(function (er) { setErr(er.message); });
    return false;
  },
  deletePage: function (id) {
    if (!confirm("Delete this page?")) return;
    api("DELETE", "/api/pages/" + id).then(function () { state.page = null; state.editingPage = false; loadPod(state.pod.id, "pages"); });
  },
  switchTimePerson: function (pid) { state.timePerson = pid; loadTimeTab(); },
  switchTimeWeek: function (w) { if (w) { state.timeWeek = mondayOf(w); loadTimeTab(); } },
  quickEntry: function (day) {
    document.getElementById("entry-day").value = day;
    document.getElementById("entry-hours").focus();
    if (!reducedMotion) document.getElementById("entry-day").scrollIntoView({ block: "center", behavior: "smooth" });
    else document.getElementById("entry-day").scrollIntoView({ block: "center" });
  },
  resetEntryForm: function () {
    document.getElementById("entry-id").value = "";
    document.getElementById("entry-day").value = todayIso();
    document.getElementById("entry-hours").value = "";
    document.getElementById("entry-note").value = "";
  },
  saveEntry: function (e) {
    e.preventDefault();
    var f = e.target, id = f.id.value;
    var body = { pod_id: state.pod.id, person_id: state.timePerson, day: f.day.value, hours: Number(f.hours.value), note: f.note.value, billable: Number(f.billable.value) };
    var p = id ? api("PUT", "/api/time/" + id, body) : api("POST", "/api/time", body);
    p.then(function () { Podium.resetEntryForm(); loadTimeTab(); setOk("Time saved."); })
      .catch(function (er) { setErr(er.message); });
    return false;
  },
  editEntry: function (id) {
    var e = state.entries.find(function (x) { return x.id === id; });
    if (!e) return;
    document.getElementById("entry-id").value = e.id;
    document.getElementById("entry-day").value = e.day;
    document.getElementById("entry-hours").value = e.hours;
    document.getElementById("entry-note").value = e.note || "";
    document.getElementById("entry-billable").value = String(e.billable);
    document.getElementById("entry-day").scrollIntoView({ block: "center" });
  },
  deleteEntry: function (id) {
    if (!confirm("Delete this entry?")) return;
    api("DELETE", "/api/time/" + id).then(function () { loadTimeTab(); }).catch(function (er) { setErr(er.message); });
  },
  savePerson: function (e) {
    e.preventDefault();
    var f = e.target, id = f.id.value;
    var body = { name: f.name.value, title: f.title.value, email: f.email.value, hourly_rate_cents: Math.round(Number(f.rate.value || 0) * 100) };
    var p = id ? api("PUT", "/api/people/" + id, body) : api("POST", "/api/people", body);
    p.then(function () { Podium.resetPersonForm(); loadPeople(); setOk("Saved."); }).catch(function (er) { setErr(er.message); });
    return false;
  },
  editPerson: function (id) {
    var pe = state.people.find(function (x) { return x.id === id; });
    if (!pe) return;
    document.getElementById("person-id").value = pe.id;
    document.getElementById("person-name").value = pe.name;
    document.getElementById("person-title").value = pe.title || "";
    document.getElementById("person-email").value = pe.email || "";
    document.getElementById("person-rate").value = (pe.hourly_rate_cents / 100).toString();
    document.getElementById("person-name").scrollIntoView({ block: "center" });
  },
  resetPersonForm: function () {
    ["person-id", "person-name", "person-title", "person-email", "person-rate"].forEach(function (i) { document.getElementById(i).value = ""; });
  },
  createPeriod: function (e) {
    e.preventDefault();
    var f = e.target;
    api("POST", "/api/periods", { label: f.label.value, start_day: f.start_day.value, end_day: f.end_day.value })
      .then(function () { loadPayroll(null); setOk("Period opened."); })
      .catch(function (er) { setErr(er.message); });
    return false;
  },
  closePeriod: function (id) {
    if (!confirm("Close this period? Entries become read-only and statements are snapshotted.")) return;
    api("POST", "/api/periods/" + id + "/close")
      .then(function () { loadPayroll(id); setOk("Period closed. Statements written."); })
      .catch(function (er) { setErr(er.message); });
  },
};

/* ---------- boot ---------- */
if (typeof window !== "undefined") {
  window.Podium = Podium;
  window.addEventListener("hashchange", route);
  // preload for sidebar + member picker
  Promise.all([api("GET", "/api/pods"), api("GET", "/api/people")]).then(function (r) {
    state.pods = r[0].pods; state.people = r[1].people;
    route();
  }).catch(function () { route(); });
}
if (typeof module !== "undefined" && module.exports) module.exports = Podium;

})();
