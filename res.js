/* Базы людей по документам: «Жители Еткульской и Еманжелинской станиц и их посёлков»,
   «Однодворцы». Каждая — свой раздел сайта, устроены одинаково (makeBase).
   Данные — res_<документ>.js, собирает prikaz_explorer.py из РС index\data\<документ>.json
   (готовит rs_import.py); в какую базу идёт документ — поле base его описания.

   Единица базы — запись документа, а не человек: один и тот же человек в разных документах —
   разные записи. Связи между ними («возможные упоминания») — отдельный слой res_links.js:
   пара записей, вероятность, разложение по признакам и статус (авто / подтверждено / отвергнуто).
   Семья — объект документа: подряд идущие записи с одним номером семьи.

   Сканы — с Яндекс Диска и локально, и в вебе: список файлов папки документа запрашивается
   при первом открытии скана. Общие помощники вёрстки — из app.js (OKV.h). */

OKV.bases = (function () {
  "use strict";

  /* Базы раздела «Жители»: у каждой свой раздел в шапке, маршрут #/<key>/…, заголовок и описание.
     Документ попадает в базу по полю base описания документа (rs_import.py, DOCS); без него — «res». */
  const BASES = [
    { key: "res", nav: "Жители Еткульской", title: "Жители Еткульской и Еманжелинской станиц и их посёлков",
      intro: "База людей по документам о жителях станиц: для каждой записи — семья целиком, возрасты, " +
        "расчётный год рождения, выбытие и скан документа.",
      example: "Важенин Иван",
      notes: ["Номера семей — как в индексе. Семья — подряд идущие записи с одним номером; повтор номера " +
        "в другом месте индекса помечен как возможная ошибка распознавания."] },
    { key: "odn", nav: "Однодворцы", title: "Однодворцы",
      intro: "Курские однодворцы, переселившиеся в Челябинский уезд, по ревизской сказке 1834 года: " +
        "для каждой записи — семья целиком, возрасты, расчётный год рождения, выбытие и скан документа.",
      example: "Суровцов Фёдор",
      notes: ["Семья — двор сказки; номера дворов в каждой сказке (деревне) свои."] },
  ];

  function makeBase(B) {
    const H = OKV.h;
    const { esc, $, $$, fold, masc, surnameMatch, debounce, sortHead, bindSort, bindRows,
      viewer } = H;

    const R = {
      docs: [], docById: new Map(), records: [], byId: new Map(),
      families: [], famById: new Map(), links: [], linksBy: new Map(),
    };

    const ST = {
      pf: { doc: "", q: "", fam: "", similar: false, name: "", otch: "", sex: "", rel: "", rank: "",
        grFrom: "", grTo: "", dep: "", flagged: false, sort: "fam", dir: 1, limit: 200 },
      ff: { doc: "", q: "", flagged: false, sort: "no", dir: 1, limit: 300 },
      sf: { doc: "", q: "", similar: false, sort: "alpha", dir: 1, limit: 300 },
    };
    const PF_RESET = { q: "", fam: "", similar: false, name: "", otch: "", sex: "", rel: "", rank: "",
      grFrom: "", grTo: "", dep: "", flagged: false, limit: 200 };

    const TABS = [
      ["persons", "Персоны", "Поиск по ФИО, году рождения, родству, чину, выбытию; карточка с семьёй и сканом."],
      ["families", "Семьи", "Семьи по номерам документа: глава, состав, листы скана."],
      ["surnames", "Фамилии", "Указатель фамилий: сколько записей и семей, годы рождения."],
      ["docs", "Документы", "Какие документы в базе, шифры, охват листов, как считались годы."]];
    const TITLE = B.title;

    /* ================= данные ================= */

    // Документы этой базы и общий слой связей (связь с записью другой базы не покажется:
    // такой записи нет в R.byId).
    function finalize(loaded, links) {
      R.links = links;
      for (const d of loaded) {
        const doc = d.doc;
        R.docs.push(doc);
        R.docById.set(doc.id, doc);
        doc.families = d.families;
        doc.records = d.records;
        d.records.forEach((r, i) => {
          r.di = i;
          r._doc = doc;
          r._fam = masc(fold(r.фамилия));
          r._famAll = [r.фамилия, r.фамилия_ориг].filter(Boolean).map((x) => masc(fold(x)));
          r._name = [r.имя, r.имя_ориг].filter(Boolean).map(fold);
          r._otch = [r.отчество, r.отчество_ориг].filter(Boolean).map(fold);
          r._by = r.рождение ? (r.рождение.год || r.рождение.от) : null;
          R.records.push(r);
          R.byId.set(r.id, r);
        });
        d.families.forEach((f, i) => {
          f.di = i;
          f._doc = doc;
          f._members = f.members.map((id) => R.byId.get(id));
          f._head = R.byId.get(f.head);
          f._members.forEach((m) => { m._family = f; });
          R.families.push(f);
          R.famById.set(f.id, f);
        });
      }
      for (const l of R.links) {
        for (const [a, b] of [[l.a, l.b], [l.b, l.a]]) {
          if (!R.linksBy.has(a)) R.linksBy.set(a, []);
          R.linksBy.get(a).push({ other: b, link: l });
        }
      }
      return R.docs.length > 0;
    }

    const has = () => R.docs.length > 0;
    const inDoc = (x, doc) => !doc || x._doc.id === doc;

    /* ================= сканы (Яндекс Диск) ================= */

    const IMG = { lists: new Map(), errors: new Set() };

    function loadDocImages(doc) {
      if (IMG.lists.has(doc.id)) return IMG.lists.get(doc.id);
      if (!doc.scans || !doc.scans.public_key) return Promise.resolve(new Map());
      const base = "https://cloud-api.yandex.net/v1/disk/public/resources";
      const map = new Map();
      // Сканы документа могут лежать в нескольких подпапках публичной папки (scans.paths).
      const paths = doc.scans.paths || ["/"];
      const page = (path, offset) => fetch(`${base}?public_key=${encodeURIComponent(doc.scans.public_key)}` +
        `&path=${encodeURIComponent(path)}&limit=1000&offset=${offset}` +
        `&fields=_embedded.total,_embedded.items.name,_embedded.items.file`)
        .then((r) => { if (!r.ok) throw new Error("Яндекс.Диск: HTTP " + r.status); return r.json(); })
        .then((data) => {
          const emb = data._embedded || {};
          const items = emb.items || [];
          items.forEach((it) => { if (it.file && !map.has(it.name)) map.set(it.name, it.file); });
          if (items.length && offset + items.length < (emb.total || 0)) return page(path, offset + items.length);
        });
      const p = Promise.all(paths.map((path) => page(path, 0))).then(() => map).catch((e) => {
        IMG.errors.add(doc.id);
        console.error("Сканы документа", doc.id, "недоступны:", e);
        return map;
      });
      IMG.lists.set(doc.id, p);
      return p;
    }

    // Источник сканов для просмотра из app.js: id страницы — «<документ>/<номер файла>».
    function scanSource(doc, map) {
      const ext = doc.scans.ext || ".jpg";
      const file = (pid) => pid.slice(pid.indexOf("/") + 1);
      // Имя файла на Диске: по шаблону документа («…s_{n}.jpg») или номер + расширение («0004.jpg»).
      const name = (pid) => (doc.scans.name ? doc.scans.name.replace("{n}", file(pid)) : file(pid) + ext);
      return {
        label: (pid) => "скан " + file(pid),
        img: (pid) => map.get(name(pid)) || null,
        orig: () => null,   // ссылки на файл на Диске в просмотре нет
        missing: (pid) => (!doc.scans.public_key ? "Сканы этого документа пока не выложены" :
          IMG.errors.has(doc.id) ? "Сканы недоступны (Яндекс Диск не ответил)" : "Скан не найден: " + file(pid)),
      };
    }

    function mountViewer(host, doc, files, active) {
      host.innerHTML = `<div class="viewer"><div class="stage"><div class="noimg">Загрузка скана…</div></div></div>`;
      loadDocImages(doc).then((map) => {
        if (!host.isConnected) return;
        viewer(host, files.map((f) => `${doc.id}/${f}`), `${doc.id}/${active || files[0]}`, null, scanSource(doc, map));
      });
    }

    /* ================= помощники вёрстки ================= */

    function fio(r) {
      const s = [r.фамилия, r.имя, r.отчество].filter(Boolean).join(" ");
      return s || "—";
    }

    // Написание источника. Части ФИО, выведенные по семье (r.выведено: фамилия жены, отчество сына),
    // в источнике не записаны — их не показываем.
    function origName(r) {
      const skip = new Set(r.выведено || []);
      const part = (k) => (skip.has(k) ? "" : r[k + "_ориг"] || r[k]);
      const o = [part("фамилия"), part("имя"), part("отчество")].filter(Boolean).join(" ");
      return (r.фамилия_ориг || r.имя_ориг || r.отчество_ориг || skip.size) ? o : "";
    }

    function birthTxt(r, long) {
      const b = r.рождение;
      if (!b) return "";
      const v = b.год != null ? "≈" + b.год : `${b.от}–${b.до}`;
      return long ? `${v} <span class="muted small">(${esc(b.по)})</span>` : v;
    }

    // 1 документ, 2 документа, 5 документов
    function plural(n, one, few, many) {
      const a = n % 10, b = n % 100;
      return a === 1 && b !== 11 ? one : a >= 2 && a <= 4 && (b < 12 || b > 14) ? few : many;
    }

    const rankTxt = (r) => [r.чин, r.служба, r.сословие].filter(Boolean).join(", ");

    // Колонки возраста — из описания документа (РС: «Лет в 1816», «Лет в 1834»; список 1865: одна).
    function ageCols(docs) {
      const seen = new Map();
      docs.forEach((d) => (d.ages || []).forEach((a) => { if (!seen.has(a.key)) seen.set(a.key, a); }));
      return [...seen.values()];
    }
    // Номер семьи с пунктом, если нумерация дворов в документе своя в каждом пункте.
    // Семья без номера (в списке 1865 «″» — двора нет: все умерли или выбыли).
    const famLabel = (f) => `${f.no ? "№ " + f.no : "без двора"}${f.place ? " · " + f.place : ""}`;

    function relTo(r) { return r.rel_to ? R.byId.get(r.rel_to) : null; }

    /* Родство к главе семьи. В индексе родство записано относительно того, на кого ссылается
       запись (колонка Q), — не всегда главы. Цепочку не сворачиваем в термин («жена сына», а не
       «сноха»): показываем только то, что записано. Пусто — если цепочка не доходит до главы. */
    const GEN = { сын: "сына", дочь: "дочери", брат: "брата", сестра: "сестры", жена: "жены", мать: "матери",
      отец: "отца", внук: "внука", внучка: "внучки", племянник: "племянника", племянница: "племянницы",
      пасынок: "пасынка", падчерица: "падчерицы", зять: "зятя", сноха: "снохи", приёмыш: "приёмыша" };

    function relToHead(r) {
      if (r.родство_текст) return r.родство_текст;   // индекс уже пишет словами: «жена сына Ивана»
      const head = r._family && r._family.head;
      if (r.id === head || r.родство === "глава") return r.id === head ? "глава" : "глава (второй в семье)";
      const chain = [];
      let cur = r;
      for (let i = 0; i < 6 && cur; i++) {
        if (!cur.родство) return "";
        chain.push(cur);
        const to = relTo(cur);
        if (!to || to.id === cur.id) return "";
        if (to.id === head) break;
        cur = to;
        if (i === 5) return "";
      }
      if (chain.length === 1) return r.родство;
      const words = [chain[0].родство, ...chain.slice(1).map((x) => GEN[x.родство] || x.родство)];
      return `${words.join(" ")} (№ ${chain[1].pos})`;
    }

    function relTxt(r, withName) {
      if (r.родство_текст) return r.родство_текст;
      if (!r.родство) return "";
      const to = relTo(r);
      if (!to || r.родство === "глава") return r.родство;
      return withName ? `${r.родство} — ${[to.имя, to.отчество].filter(Boolean).join(" ") || fio(to)} (№ ${to.pos})` : `${r.родство} № ${to.pos}`;
    }

    function depTxt(r) {
      const u = r.убытие;
      if (!u) return "";
      return u.текст || (u.год ? "выбыл(а) в " + u.год : "выбыл(а)");
    }

    const personHref = (r) => `#/${B.key}/person/${encodeURIComponent(r.id)}`;
    const familyHref = (f) => `#/${B.key}/family/${encodeURIComponent(f.id)}`;
    const docRef = (doc) => `${doc.archive}. Ф. ${doc.fond}. Оп. ${doc.opis}. Д. ${doc.delo}`;

    function docSelect(value) {
      if (R.docs.length < 2) return "";
      return `<label>Документ <select data-doc><option value="">Все</option>
        ${R.docs.map((d) => `<option value="${esc(d.id)}"${d.id === value ? " selected" : ""}>${esc(d.short)}</option>`).join("")}</select></label>`;
    }

    function bindDoc(root, st, rerender) {
      const sel = $("[data-doc]", root);
      if (sel) sel.addEventListener("change", () => { st.doc = sel.value; st.limit = 300; rerender(); });
    }

    function flagCount(r) { return r.flags.length + (r._family ? r._family.flags.length : 0); }

    /* ================= главная сайта: блок базы ================= */

    function totals() {
      return { records: R.records.length, families: R.families.length, docs: R.docs.length };
    }

    function fioForm(id) {
      return `<form data-home="fio">
          <label for="${id}">Поиск по ФИО</label>
          <div class="row">
            <input id="${id}" type="search" placeholder="например, ${esc(B.example)}" autocomplete="off">
            <button class="primary" type="submit">Найти</button>
          </div>
          <span class="hint">Фамилия, имя, отчество — в любом порядке, каждое по началу слова. Старая орфография учтена.</span>
        </form>`;
    }

    function bindFio(root) {
      $$('form[data-home="fio"]', root).forEach((form) => form.addEventListener("submit", (e) => {
        e.preventDefault();
        Object.assign(ST.pf, PF_RESET, { doc: "", q: $("input", form).value.trim(), sort: "fam", dir: 1 });
        H.S.scroll[`${B.key}/persons`] = 0;
        location.hash = `#/${B.key}/persons`;
      }));
    }

    function docsLine() {
      return R.docs.map((d) => `${esc(d.title)}`).join("; ");
    }

    const extLink = (l) => (l.url ? `<a href="${esc(l.url)}" target="_blank" rel="noopener">${esc(l.text)}</a>` : esc(l.text));

    // Источник документа словами автора базы (source в реестре документов rs_import.py).
    function sourceItem(d) {
      const s = d.source;
      if (!s) return `<li>${esc(d.title)}. ${esc(docRef(d))}.</li>`;
      return `<li><b>${esc(s.title)}</b>.${s.ref ? ` Первоисточник ${extLink(s.ref)}.` : ""}
        ${(s.notes || []).map((n) => `${esc(n.text)}${n.link ? " " + extLink(n.link) : ""}.`).join(" ")}
        ${creditTxt(d)}</li>`;
    }

    // Чужая индексация: кто провёл и дал доступ (source.credit) — имя жирным, ссылка на его базу.
    function creditTxt(d) {
      const c = d.source && d.source.credit;
      if (!c) return "";
      const host = c.url ? c.url.replace(/^https?:\/\//, "").replace(/\/$/, "") : "";
      return `${esc(c.text)} <b>${esc(c.name)}</b>${c.url ? ` (${extLink({ text: host, url: c.url })})` : ""}.`;
    }

    function sourcesBlock(tag) {
      return `<${tag}>Источники базы</${tag}><ul class="facts sources">${R.docs.map(sourceItem).join("")}</ul>`;
    }

    function homeBlock() {
      const t = totals();
      const surnames = surnameGroups("").length;
      return `
        <section class="base panel">
          <h2>${esc(TITLE)}</h2>
          <p>${esc(B.intro)}</p>
          ${sourcesBlock("h3")}
          <p class="base-stats"><b>${t.records}</b> ${plural(t.records, "запись", "записи", "записей")} ·
            <b>${t.families}</b> ${plural(t.families, "семья", "семьи", "семей")} ·
            <b>${surnames}</b> ${plural(surnames, "фамилия", "фамилии", "фамилий")} ·
            <b>${t.docs}</b> ${plural(t.docs, "документ", "документа", "документов")}</p>
          <div class="home-search">${fioForm(`home-fio-${B.key}`)}</div>
          ${factsBlock()}
        </section>`;
    }

    function bindHomeBlock(root) { bindFio(root); }

    /* ================= страница раздела ================= */

    // Как собраны данные — раскрывающимся блоком на главной.
    function factsBlock() {
      const gaps = R.docs.filter((d) => d.files_missing && d.files_missing.length);
      return `<details class="howto"><summary>Как собраны данные</summary>
          <ul class="facts">
            ${R.docs.map((d) => (d.facts || []).map((x) => `<li>${esc(x)}</li>`).join("")).join("")}
            <li>В указателях орфография современная, написание индекса показано рядом. Всё, что записано
              в индексе и не легло в поля, — в «Дополнительной информации» карточки.</li>
            ${(B.notes || []).map((x) => `<li>${esc(x)}</li>`).join("")}
            ${gaps.map((d) => `<li>${esc(d.short)}: не проиндексированы сканы ${esc(rangesTxt(d.files_missing))}.</li>`).join("")}
          </ul>
        </details>`;
    }

    function rangesTxt(list) {
      const out = [];
      let run = [];
      for (const f of list) {
        if (run.length && +f === +run[run.length - 1] + 1) run.push(f);
        else { if (run.length) out.push(run); run = [f]; }
      }
      if (run.length) out.push(run);
      return out.map((r) => (r.length === 1 ? r[0] : `${r[0]}–${r[r.length - 1]}`)).join(", ");
    }

    /* ================= Персоны ================= */

    /* ФИО свободной строкой: каждое слово — по началу фамилии, имени или отчества, разные слова —
       в разные поля. Ранг 0 — отчество совпало только вместе с именем («Важенин Иван Ларионович»,
       «Иван Ларионович»); ранг 1 — слово попало только в отчество («Важенин Иван» → Авдотья Ивановна):
       такие записи идут после. null — не подходит. */
    function matchQ(r, words) {
      const fields = [
        (w) => r._famAll.some((f) => f.startsWith(masc(w)) || f.startsWith(w)),
        (w) => r._name.some((n) => n.startsWith(w)),
        (w) => r._otch.some((o) => o.startsWith(w)),
      ];
      if (words.length > 3) return words.every((w) => fields.some((fn) => fn(w))) ? 1 : null;
      let best = null;
      const go = (i, used) => {
        if (best === 0) return;
        if (i === words.length) {
          const rank = used[2] && !used[1] ? 1 : 0;
          if (best === null || rank < best) best = rank;
          return;
        }
        for (let k = 0; k < 3; k++) {
          if (used[k] || !fields[k](words[i])) continue;
          used[k] = true; go(i + 1, used); used[k] = false;
        }
      };
      go(0, [false, false, false]);
      return best;
    }

    function filterPersons(f) {
      const words = fold(f.q).split(/[^0-9a-zа-я-]+/).filter(Boolean);
      const name = fold(f.name.trim()), otch = fold(f.otch.trim());
      const grFrom = parseInt(f.grFrom, 10), grTo = parseInt(f.grTo, 10);
      const res = [];
      for (const r of R.records) {
        if (!inDoc(r, f.doc)) continue;
        const rank = words.length ? matchQ(r, words) : 0;
        if (rank === null) continue;
        let match = "";
        if (f.fam.trim()) {
          match = surnameMatch(f.fam, r.фамилия, f.similar) || (r.фамилия_ориг && surnameMatch(f.fam, r.фамилия_ориг, f.similar));
          if (!match) continue;
        }
        if (name && !r._name.some((n) => n.startsWith(name))) continue;
        if (otch && !r._otch.some((o) => o.startsWith(otch))) continue;
        if (f.sex && r.пол !== f.sex) continue;
        if (f.rel && r.родство !== f.rel) continue;
        if (f.rank === "*" ? !r.чин : (f.rank && r.чин !== f.rank)) continue;
        if (!isNaN(grFrom) && !(r._by >= grFrom)) continue;
        if (!isNaN(grTo) && !(r._by <= grTo)) continue;
        if (f.dep === "died" && !r.год_смерти) continue;
        if (f.dep === "left" && !(r.убытие && !r.год_смерти)) continue;
        if (f.dep === "here" && r.убытие) continue;
        if (f.flagged && !flagCount(r)) continue;
        res.push({ r, match, rank });
      }
      const cmp = {
        fam: (a, b) => (!a.r._fam - !b.r._fam) ||
          (a.r._fam + " " + (a.r._name[0] || "")).localeCompare(b.r._fam + " " + (b.r._name[0] || ""), "ru"),
        gr: (a, b) => (a.r._by || 9999) - (b.r._by || 9999),
        doc: (a, b) => a.r.di - b.r.di,
      }[f.sort] || (() => 0);
      res.sort((a, b) => {
        if (a.rank !== b.rank) return a.rank - b.rank;
        if (a.match !== b.match) return a.match === "exact" ? -1 : b.match === "exact" ? 1 : 0;
        return cmp(a, b) * f.dir || a.r.di - b.r.di;
      });
      return res;
    }

    function viewPersons(app) {
      const f = ST.pf;
      const rels = [...new Set(R.records.map((r) => r.родство).filter(Boolean))].sort((a, b) => a.localeCompare(b, "ru"));
      const ranks = [...new Set(R.records.map((r) => r.чин).filter(Boolean))].sort((a, b) => a.localeCompare(b, "ru"));
      app.innerHTML = `
        <div class="panel">
          <div class="filters">
            ${docSelect(f.doc)}
            <label class="wide">ФИО <input type="search" data-f="q" placeholder="Важенин Иван Ларионович — в любом порядке"></label>
            <label>Фамилия <input type="search" data-f="fam" placeholder="Меньшенин или Печенкин/Печеркин"></label>
            <label>Имя <input type="search" data-f="name"></label>
            <label>Отчество <input type="search" data-f="otch"></label>
            <label>Пол <select data-f="sex"><option value="">любой</option><option value="м">мужской</option><option value="ж">женский</option></select></label>
            <label>Родство <select data-f="rel"><option value="">любое</option>
              ${rels.map((x) => `<option>${esc(x)}</option>`).join("")}</select></label>
            <label>Чин <select data-f="rank"><option value="">любой</option><option value="*">с чином</option>
              ${ranks.map((x) => `<option>${esc(x)}</option>`).join("")}</select></label>
            <label>Год рождения (расчётный) <span class="pair">
              <input type="number" data-f="grFrom" placeholder="от"><input type="number" data-f="grTo" placeholder="до"></span></label>
            <label>Выбытие <select data-f="dep"><option value="">все</option><option value="here">налицо</option>
              <option value="died">умерли</option><option value="left">выбыли иначе</option></select></label>
            <label class="check"><input type="checkbox" data-f="similar"> похожие написания фамилии</label>
            <label class="check checks"><input type="checkbox" data-f="flagged"> только с пометками «проверить»</label>
          </div>
        </div>
        <div class="toolbar">
          <span data-count class="count"></span><span class="grow"></span>
          <span class="hint">Фамилия по началу, женская форма равна мужской. Щелчок по строке — карточка с семьёй и сканом.</span>
          <button data-reset>Сбросить</button>
        </div>
        <div data-results></div>`;

      bindDoc(app, f, () => { f.limit = 200; draw(); });
      $$("[data-f]", app).forEach((el) => {
        const k = el.dataset.f;
        if (el.type === "checkbox") el.checked = !!f[k]; else el.value = f[k];
        const upd = () => { f[k] = el.type === "checkbox" ? el.checked : el.value; f.limit = 200; draw(); };
        el.addEventListener(el.tagName === "SELECT" || el.type === "checkbox" ? "change" : "input",
          el.tagName === "INPUT" && el.type !== "checkbox" ? debounce(upd, 150) : upd);
      });
      $("[data-reset]", app).addEventListener("click", () => { Object.assign(f, PF_RESET, { doc: "" }); viewPersons(app); });

      function draw() {
        const res = filterPersons(f);
        const similarN = res.filter((x) => x.match === "similar").length;
        const byOtch = res.filter((x) => x.rank === 1).length;
        $("[data-count]", app).textContent = `Найдено: ${res.length}` +
          (similarN ? ` (из них похожих написаний: ${similarN})` : "") +
          (byOtch && byOtch < res.length ? ` · совпадение только по отчеству — в конце списка: ${byOtch}` : "");
        const box = $("[data-results]", app);
        if (!res.length) { box.innerHTML = `<p class="empty">Ничего не найдено.</p>`; return; }
        const ages = ageCols(f.doc ? [R.docById.get(f.doc)] : R.docs);
        const rows = res.slice(0, f.limit).map(({ r, match }) => `
          <tr data-href="${esc(personHref(r))}" class="${r.убытие ? "gone" : ""}">
            <td><span class="name">${esc(fio(r))}</span>
              ${match === "similar" ? ` <span class="pill tag-similar">похоже</span>` : ""}
              ${flagCount(r) ? ` <span class="pill conf-medium checks" title="есть пометки «проверить»">проверить</span>` : ""}
              ${origName(r) ? `<div class="orig">${esc(origName(r))}</div>` : ""}</td>
            <td class="num">${esc(birthTxt(r))}</td>
            <td class="num">${esc(r.fam_no || "")}${r._family && r._family.place ? `<div class="muted small">${esc(r._family.place)}</div>` : ""}</td>
            <td>${esc(relTxt(r))}</td>
            <td class="nowrap">${esc(r._doc.short)}<div class="muted small">скан ${esc(r.file || "?")}</div></td>
            <td>${esc(rankTxt(r))}</td>
            ${ages.map((a) => `<td class="num">${esc(r[a.key] || "")}</td>`).join("")}
            <td class="ev">${esc(depTxt(r))}</td>
          </tr>`).join("");
        box.innerHTML = `<div class="tablewrap"><table class="grid">
          <thead>${sortHead([["fam", "Фамилия, имя, отчество"], ["gr", "Г. р."], ["", "Семья"], ["", "Родство"],
            ["doc", "Документ"], ["", "Чин, сословие"], ...ages.map((a) => ["", a.label]), ["", "Выбытие"]], f)}</thead>
          <tbody>${rows}</tbody></table></div>
          ${res.length > f.limit ? `<div class="more"><button data-more>Показать ещё (${res.length - f.limit})</button></div>` : ""}`;
        bindRows(box);
        bindSort(box, f, draw);
        const more = $("[data-more]", box);
        if (more) more.addEventListener("click", () => { f.limit += 500; draw(); });
      }
      draw();
    }

    /* ================= Карточка персоны ================= */

    function familyRows(f, meId) {
      return f._members.map((m) => {
        const to = relTo(m);
        return `<tr data-href="${esc(personHref(m))}" class="${m.id === meId ? "me" : ""} ${m.убытие ? "gone" : ""}">
          <td class="num">${esc(m.pos != null ? m.pos : "")}</td>
          <td><span class="name">${esc(fio(m))}</span>${origName(m) ? `<div class="orig">${esc(origName(m))}</div>` : ""}</td>
          <td>${m.родство_текст ? esc(m.родство_текст) : `${esc(m.родство || "")}${to && m.родство !== "глава" ? ` <span class="muted small">к № ${esc(to.pos)}</span>` : ""}`}</td>
          <td>${esc(rankTxt(m))}</td>
          ${(f._doc.ages || []).map((a) => `<td class="num">${esc(m[a.key] || "")}</td>`).join("")}
          <td class="num">${esc(birthTxt(m))}</td>
          <td class="ev">${esc(depTxt(m))}</td>
        </tr>`;
      }).join("");
    }

    const familyHead = (doc) => `<thead><tr><th class="nosort">№</th><th class="nosort">ФИО</th><th class="nosort">Родство</th>
      <th class="nosort">Чин, сословие</th>${(doc.ages || []).map((a) => `<th class="nosort">${esc(a.label)}</th>`).join("")}
      <th class="nosort">Г. р.</th><th class="nosort">Выбытие</th></tr></thead>`;

    function linksBlock(r) {
      const ls = (R.linksBy.get(r.id) || []).filter((x) => x.link.status !== "отвергнуто")
        .sort((a, b) => (b.link.score || 0) - (a.link.score || 0));
      if (!ls.length) {
        return `<p class="links-empty">${R.docs.length < 2
          ? "В базе пока один документ — сопоставлять не с чем. Когда будут добавлены другие документы, здесь появятся записи, которые, вероятно, относятся к этому же человеку, с вероятностью и признаками совпадения."
          : "Возможных упоминаний в других документах не найдено."}</p>`;
      }
      return `<div class="tablewrap"><table class="grid"><thead><tr><th class="nosort">Вероятность</th>
        <th class="nosort">Запись</th><th class="nosort">Документ</th><th class="nosort">Совпало</th><th class="nosort">Статус</th></tr></thead><tbody>
        ${ls.map(({ other, link }) => {
          const o = R.byId.get(other);
          if (!o) return "";
          const fac = link.factors ? Object.entries(link.factors).map(([k, v]) => `${k}: ${v}`).join(", ") : "";
          return `<tr data-href="${esc(personHref(o))}">
            <td class="score">${link.score != null ? Math.round(link.score * 100) + " %" : ""}</td>
            <td><span class="name">${esc(fio(o))}</span> <span class="muted small">${esc(birthTxt(o))}</span></td>
            <td>${esc(o._doc.short)}</td><td class="small">${esc(fac)}</td><td>${esc(link.status || "авто")}</td></tr>`;
        }).join("")}</tbody></table></div>`;
    }

    // Номера в семье числами (РС) — нумерованный список; 1м/1ж (список 1865) — подписи.
    const numPos = (f) => f._members.every((m) => m.pos == null || /^\d+$/.test(String(m.pos)));

    function viewPerson(app, id) {
      const r = R.byId.get(id);
      if (!r) { app.innerHTML = `<p class="empty">Запись ${esc(id)} не найдена.</p>`; return; }
      const doc = r._doc, f = r._family;
      const prev = doc.records[r.di - 1], next = doc.records[r.di + 1];
      const to = relTo(r);
      const u = r.убытие, p = r.поступление;
      const flags = [...r.flags, ...f.flags.map((x) => "Семья: " + x)];
      const cols = doc.columns || {};
      const rawRows = Object.entries(r.raw || {}).map(([k, v]) =>
        `<dt>${esc(cols[k] || k)} <span class="muted small">${esc(k)}</span></dt><dd>${esc(v)}</dd>`).join("");
      app.innerHTML = `
        <div class="split">
          <div class="left">
            <div class="crumbs">
              <a href="javascript:history.back()">← назад</a><span class="sep">|</span>
              <a href="#/${B.key}/persons">персоны</a><span class="sep">|</span>
              ${prev ? `<a href="${esc(personHref(prev))}">‹ ${esc(fio(prev))}</a>` : ""}
              ${next ? `<a href="${esc(personHref(next))}">${esc(fio(next))} ›</a>` : ""}
            </div>
            <div class="card-h"><h1>${esc(fio(r))}</h1>
              <span class="sexmark">${r.пол === "м" ? "муж." : r.пол === "ж" ? "жен." : ""}</span></div>
            ${origName(r) ? `<div class="orig">в индексе: ${esc(origName(r))}</div>` : ""}
            <dl class="meta">
              <dt>Документ</dt><dd><a href="#/${B.key}/doc/${esc(doc.id)}">${esc(doc.title)}</a></dd>
              <dt>Источник</dt><dd>${esc(docRef(doc))}, скан ${esc(r.file || "?")} · № п/п ${esc(r.n != null ? r.n : "—")}</dd>
              <dt>Семья</dt><dd><a href="${esc(familyHref(f))}">${esc(famLabel(f))}</a> · № в семье ${esc(r.pos != null ? r.pos : "—")}</dd>
              <dt>Состав семьи по ${esc(doc.short_by || doc.short)}</dt><dd><ol class="famlist${numPos(f) ? "" : " labeled"}">${f._members.map((m) => {
                const rel = relToHead(m);
                return `<li class="${m.id === r.id ? "me" : ""} ${m.убытие ? "gone" : ""}"${numPos(f) ? ` value="${esc(m.pos != null ? m.pos : "")}"` : ""}>
                  ${numPos(f) ? "" : `<span class="pos">${esc(m.pos || "")}</span>`}${m.id === r.id ? `<b>${esc(fio(m))}</b>` : `<a href="${esc(personHref(m))}">${esc(fio(m))}</a>`}${m.рождение ? `, ${esc(birthTxt(m))}` : ""}
                  — ${rel ? esc(rel) : `<span class="muted">${esc(relTxt(m) || "родство не указано")}</span>`}</li>`;
              }).join("")}</ol></dd>
              ${r.родство_текст ? `<dt>Родство</dt><dd>${esc(r.родство_текст)}</dd>${kinLinks(r)}`
              : `<dt>Родство</dt><dd>${r.родство ? esc(r.родство) : '<span class="muted">не указано</span>'}${to && r.родство !== "глава"
                ? ` — к <a href="${esc(personHref(to))}">${esc(fio(to))}</a> (№ ${esc(to.pos)})` : ""}</dd>`}
              ${r.сословие ? `<dt>Сословие</dt><dd>${esc(r.сословие)}</dd>` : ""}
              ${r.чин ? `<dt>Чин</dt><dd>${esc(r.чин)}</dd>` : ""}
              ${r.служба ? `<dt>Служба</dt><dd>${esc(r.служба)}</dd>` : ""}
              ${(doc.ages || []).map((a) => `<dt>${esc(a.label)}</dt><dd>${esc(r[a.key] || "—")}</dd>`).join("")}
              <dt>Год рождения</dt><dd>${r.рождение ? birthTxt(r, true) : '<span class="muted">не рассчитан</span>'}
                ${r.рождение && r.рождение.альт ? `<div class="small">по ${esc(r.рождение.альт.по)} — ≈${esc(r.рождение.альт.год)}</div>` : ""}</dd>
              ${p ? `<dt>Поступление</dt><dd>${esc(p.текст || "")}${p.откуда ? ", откуда: " + esc(p.откуда) : ""}${p.год && !(p.текст || "").includes(p.год) ? ` (${esc(p.год)})` : ""}</dd>` : ""}
              ${u ? `<dt>Выбытие</dt><dd>${esc(u.текст || "")}${u.год && !(u.текст || "").includes(u.год) ? ` (${esc(u.год)})` : ""}
                <span class="muted small">· ${esc(u.вид)}</span>${u.куда ? ", куда: " + esc(u.куда) : ""}</dd>` : ""}
              ${r.год_смерти ? `<dt>Год смерти</dt><dd>${esc(r.год_смерти)}</dd>` : ""}
              ${r.место_приписки || doc.kanton ? `<dt>Место приписки</dt><dd>${esc(r.место_приписки || "—")}${doc.kanton ? `, ${esc(doc.kanton)}` : ""}</dd>` : ""}
              <dt>Место проживания</dt><dd>${r.место_проживания ? esc(r.место_проживания) : '<span class="muted">в документе не указано</span>'}</dd>
              ${r.выход ? `<dt>Место выхода</dt><dd>${esc(r.выход.текст)}${r.выход.url ? ` · ${extLink({ text: "источник", url: r.выход.url })}` : ""}
                ${r.выход.основание ? `<div class="muted small">${esc(r.выход.основание)}</div>` : ""}</dd>` : ""}
              ${surnameDictDd(r)}
              ${r.уверенность ? `<dt>Уверенность чтения</dt><dd>${esc(r.уверенность)} <span class="muted small">(оценка индексатора)</span></dd>` : ""}
            </dl>

            <h2>Семья ${esc(famLabel(f))} <span class="count">${f._members.length}</span></h2>
            <p class="hint">Щелчок по строке — карточка члена семьи. Серым — умершие и выбывшие до ревизии.</p>
            <div class="tablewrap"><table class="grid">${familyHead(doc)}<tbody>${familyRows(f, r.id)}</tbody></table></div>

            <h2>Возможные упоминания</h2>
            ${linksBlock(r)}

            ${r.extra.length ? `<h2>Дополнительная информация</h2>
              <p class="hint">Из индекса — то, что не легло в поля карточки, как записано индексатором.</p>
              <ul class="extralist">${r.extra.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>` : ""}

            ${flags.length ? `<h2 class="checks">Что проверить по скану</h2><ul class="flaglist checks">${flags.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>` : ""}

            <details class="raw"><summary>Всё, что записано в индексе (${esc(doc.row_label || "строка Excel")} ${esc(r.row)})</summary>
              <div class="detail"><dl>${rawRows}</dl></div></details>
          </div>
          <div class="right" data-viewer></div>
        </div>`;
      bindRows(app);
      mountViewer($("[data-viewer]", app), doc, f.files.length ? f.files : [r.file], r.file);
      window.scrollTo(0, 0);
    }

    // Отец и муж — связи индекса (РС курских переселенцев), ссылками на карточки.
    function kinLinks(r) {
      return [["Отец", r.отец_id], ["Муж", r.муж_id]].map(([k, id]) => [k, R.byId.get(id)]).filter(([, x]) => x)
        .map(([k, x]) => `<dt>${k}</dt><dd><a href="${esc(personHref(x))}">${esc(fio(x))}</a></dd>`).join("");
    }

    // Фамилия в словаре индексатора (doc.surname_dict): статус проверки, форма, источник.
    // Без статуса не показывается: проверки по снятому источнику убраны при импорте (rs_import.py).
    function surnameDict(r) {
      const s = r.фамилия_словарь && r._doc.surname_dict ? r._doc.surname_dict[r.фамилия_словарь] : null;
      return s && s.status ? s : null;
    }

    function surnameDictDd(r) {
      const s = surnameDict(r);
      if (!s) return "";
      return `<dt>Фамилия в словаре индексатора</dt><dd>${esc(s.status || "")}${s.confidence ? `, уверенность ${esc(s.confidence)}` : ""}
        ${s.historic ? `<div class="small">в источнике: ${esc(s.historic)}${s.variants ? `; варианты: ${esc(s.variants)}` : ""}</div>` : ""}
        ${s.reference ? `<div class="muted small">${esc(s.reference)}${s.url ? " " + extLink({ text: "источник проверки", url: s.url }) : ""}</div>` : ""}</dd>`;
    }

    /* ================= Семьи ================= */

    function familySurnames(f) {
      const m = new Map();
      f._members.forEach((x) => { if (x.фамилия) { const k = masc(fold(x.фамилия)); if (!m.has(k)) m.set(k, x.пол === "м" ? x.фамилия : x.фамилия); } });
      return [...m.values()];
    }

    function viewFamilies(app) {
      const f = ST.ff;
      app.innerHTML = `
        <div class="panel"><div class="filters">
          ${docSelect(f.doc)}
          <label>Фамилия в семье или № семьи <input type="search" data-q placeholder="Важенин или 34"></label>
          <label class="check checks"><input type="checkbox" data-flag> только с пометками</label>
        </div></div>
        <div class="toolbar"><span class="count" data-count></span><span class="grow"></span>
          <span class="hint">Номера — как в индексе. Щелчок — состав семьи и скан.</span></div>
        <div data-results></div>`;
      const q = $("[data-q]", app), fl = $("[data-flag]", app);
      q.value = f.q; fl.checked = f.flagged;
      bindDoc(app, f, draw);
      q.addEventListener("input", debounce(() => { f.q = q.value; f.limit = 300; draw(); }, 150));
      fl.addEventListener("change", () => { f.flagged = fl.checked; draw(); });

      function draw() {
        const qq = f.q.trim();
        const list = R.families.filter((x) => inDoc(x, f.doc) && (!f.flagged || x.flags.length) &&
          (!qq || (/^\d+$/.test(qq) ? String(x.no) === qq : x._members.some((m) => surnameMatch(qq, m.фамилия, false)))));
        const num = (x) => parseInt(x.no, 10);
        if (f.sort === "no") list.sort((a, b) => ((num(a) || 1e9) - (num(b) || 1e9) || a.di - b.di) * f.dir);
        else if (f.sort === "head") list.sort((a, b) => fio(a._head).localeCompare(fio(b._head), "ru") * f.dir);
        else if (f.sort === "count") list.sort((a, b) => (b._members.length - a._members.length) * f.dir);
        else list.sort((a, b) => a.di - b.di);
        $("[data-count]", app).textContent = `Семей: ${list.length}`;
        const box = $("[data-results]", app);
        if (!list.length) { box.innerHTML = `<p class="empty">Ничего не найдено.</p>`; return; }
        const rows = list.slice(0, f.limit).map((x) => {
          const m = x._members.filter((y) => y.пол === "м").length;
          const gone = x._members.filter((y) => y.убытие).length;
          return `<tr data-href="${esc(familyHref(x))}">
            <td class="num">${esc(x.no || "—")}${x.place ? `<div class="muted small">${esc(x.place)}</div>` : ""}</td>
            <td><span class="name">${esc(fio(x._head))}</span>${x._head.чин ? ` <span class="muted small">${esc(x._head.чин)}</span>` : ""}</td>
            <td class="num">${x._members.length} <span class="muted small">(м ${m}, ж ${x._members.length - m}${gone ? `, выбыло ${gone}` : ""})</span></td>
            <td>${esc(familySurnames(x).join(", "))}</td>
            <td class="num">${esc(x.files.join(", "))}</td>
            <td>${x.flags.length ? `<span class="pill conf-medium checks" title="${esc(x.flags.join("; "))}">проверить</span>` : ""}</td>
            <td class="muted small">${esc(x._doc.short)}</td>
          </tr>`;
        }).join("");
        box.innerHTML = `<div class="tablewrap"><table class="grid">
          <thead>${sortHead([["no", "№"], ["head", "Глава"], ["count", "Состав"], ["", "Фамилии"], ["", "Сканы"], ["", ""], ["doc", "Документ"]], f)}</thead>
          <tbody>${rows}</tbody></table></div>
          ${list.length > f.limit ? `<div class="more"><button data-more>Показать ещё (${list.length - f.limit})</button></div>` : ""}`;
        bindRows(box);
        bindSort(box, f, draw);
        const more = $("[data-more]", box);
        if (more) more.addEventListener("click", () => { f.limit += 1000; draw(); });
      }
      draw();
    }

    function viewFamily(app, id) {
      const f = R.famById.get(id);
      if (!f) { app.innerHTML = `<p class="empty">Семья ${esc(id)} не найдена.</p>`; return; }
      const doc = f._doc;
      const prev = doc.families[f.di - 1], next = doc.families[f.di + 1];
      app.innerHTML = `
        <div class="split">
          <div class="left">
            <div class="crumbs">
              <a href="javascript:history.back()">← назад</a><span class="sep">|</span>
              <a href="#/${B.key}/families">семьи</a><span class="sep">|</span>
              ${prev ? `<a href="${esc(familyHref(prev))}">‹ ${esc(famLabel(prev))}</a>` : ""}
              ${next ? `<a href="${esc(familyHref(next))}">${esc(famLabel(next))} ›</a>` : ""}
            </div>
            <h1>Семья ${esc(famLabel(f))} <span class="muted">· ${esc(fio(f._head))}</span></h1>
            <dl class="meta">
              <dt>Документ</dt><dd><a href="#/${B.key}/doc/${esc(doc.id)}">${esc(doc.title)}</a></dd>
              <dt>Источник</dt><dd>${esc(docRef(doc))}, скан ${esc(f.files.join(", "))}</dd>
              <dt>Состав</dt><dd>${f._members.length} записей</dd>
            </dl>
            ${f.flags.length ? `<ul class="flaglist checks">${f.flags.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>` : ""}
            <div class="tablewrap"><table class="grid">${familyHead(doc)}<tbody>${familyRows(f, null)}</tbody></table></div>
          </div>
          <div class="right" data-viewer></div>
        </div>`;
      bindRows(app);
      mountViewer($("[data-viewer]", app), doc, f.files, f.files[0]);
      window.scrollTo(0, 0);
    }

    /* ================= Фамилии ================= */

    const surnameCache = new Map();

    function surnameGroups(doc) {
      if (surnameCache.has(doc)) return surnameCache.get(doc);
      const groups = new Map();
      for (const r of R.records) {
        if (!inDoc(r, doc) || !r.фамилия) continue;
        const key = r._fam;
        let g = groups.get(key);
        if (!g) groups.set(key, g = { key, names: new Map(), origs: new Set(), fams: new Set(), n: 0, m: 0, by: [], dict: null });
        if (!g.dict) g.dict = surnameDict(r);
        g.n++;
        if (r.пол === "м") { g.m++; g.names.set(r.фамилия, (g.names.get(r.фамилия) || 0) + 2); }
        else g.names.set(r.фамилия, (g.names.get(r.фамилия) || 0) + 1);
        if (r.фамилия_ориг) g.origs.add(r.фамилия_ориг);
        g.fams.add(r.fam);
        if (r._by) g.by.push(r._by);
      }
      const list = [...groups.values()].map((g) => ({
        key: g.key, name: [...g.names.entries()].sort((a, b) => b[1] - a[1])[0][0], n: g.n, m: g.m,
        fams: g.fams.size, origs: [...g.origs].slice(0, 4),
        by: g.by.length ? [Math.min(...g.by), Math.max(...g.by)] : null, dict: g.dict,
      }));
      surnameCache.set(doc, list);
      return list;
    }

    function viewSurnames(app) {
      const f = ST.sf;
      app.innerHTML = `
        <div class="panel"><div class="filters">
          ${docSelect(f.doc)}
          <label>Фамилия <input type="search" data-q placeholder="начало фамилии"></label>
          <label class="check"><input type="checkbox" data-sim> похожие написания</label>
        </div></div>
        <div class="toolbar"><span class="count" data-count></span><span class="grow"></span>
          <span class="hint">Женские формы сведены к мужской. Щелчок — все записи с фамилией.</span></div>
        <div data-results></div>`;
      const q = $("[data-q]", app), sim = $("[data-sim]", app);
      q.value = f.q; sim.checked = f.similar;
      bindDoc(app, f, draw);
      q.addEventListener("input", debounce(() => { f.q = q.value; f.limit = 300; draw(); }, 150));
      sim.addEventListener("change", () => { f.similar = sim.checked; draw(); });

      function draw() {
        const list = surnameGroups(f.doc).map((g) => ({ g, m: f.q.trim() ? surnameMatch(f.q, g.name, f.similar) : "exact" }))
          .filter((x) => x.m);
        const dict = list.some((x) => x.g.dict);
        const cmp = f.sort === "alpha"
          ? (a, b) => a.g.key.localeCompare(b.g.key, "ru") * f.dir
          : (a, b) => (b.g.n - a.g.n) * f.dir || a.g.key.localeCompare(b.g.key, "ru");
        list.sort((a, b) => (a.m === b.m ? 0 : a.m === "exact" ? -1 : 1) || cmp(a, b));
        $("[data-count]", app).textContent = `Фамилий: ${list.length}`;
        const box = $("[data-results]", app);
        if (!list.length) { box.innerHTML = `<p class="empty">Ничего не найдено.</p>`; return; }
        box.innerHTML = `<div class="tablewrap"><table class="grid">
          <thead>${sortHead([["alpha", "Фамилия"], ["count", "Записей"], ["", "Семей"], ["", "Написание в индексе"], ["", "Годы рождения"],
            ...(dict ? [["", "Проверка фамилии (индексатор)"]] : [])], f)}</thead>
          <tbody>${list.slice(0, f.limit).map(({ g, m }) => `
            <tr data-name="${esc(g.name)}">
              <td><span class="name">${esc(g.name)}</span>${m === "similar" ? ` <span class="pill tag-similar">похоже</span>` : ""}</td>
              <td class="num">${g.n} <span class="muted small">(м ${g.m}, ж ${g.n - g.m})</span></td>
              <td class="num">${g.fams}</td>
              <td class="orig">${esc(g.origs.join(", "))}</td>
              <td class="num">${g.by ? esc(g.by[0] === g.by[1] ? g.by[0] : g.by[0] + "–" + g.by[1]) : ""}</td>
              ${dict ? `<td class="small">${g.dict ? esc(g.dict.status || "") : ""}</td>` : ""}
            </tr>`).join("")}</tbody></table></div>
          ${list.length > f.limit ? `<div class="more"><button data-more>Показать ещё (${list.length - f.limit})</button></div>` : ""}`;
        bindSort(box, f, draw);
        $$("tr[data-name]", box).forEach((tr) => tr.addEventListener("click", () => {
          Object.assign(ST.pf, PF_RESET, { doc: f.doc, fam: tr.dataset.name, sort: "doc", dir: 1 });
          H.S.scroll[`${B.key}/persons`] = 0;
          location.hash = `#/${B.key}/persons`;
        }));
        const more = $("[data-more]", box);
        if (more) more.addEventListener("click", () => { f.limit += 1000; draw(); });
      }
      draw();
    }

    /* ================= Документы ================= */

    function viewDocs(app) {
      app.innerHTML = `
        <h1>Документы базы</h1>
        <div class="tablewrap"><table class="grid">
          <thead><tr><th class="nosort">Документ</th><th class="nosort">Шифр</th><th class="nosort">Записей</th>
            <th class="nosort">Семей</th><th class="nosort">Сканы в индексе</th><th class="nosort">Не проиндексировано</th></tr></thead>
          <tbody>${R.docs.map((d) => `<tr data-href="#/${B.key}/doc/${esc(d.id)}">
            <td><span class="name">${esc(d.title)}</span><div class="muted small">${esc(d.type)}</div></td>
            <td class="nowrap">${esc(docRef(d))}</td>
            <td class="num">${d.records.length}</td><td class="num">${d.families.length}</td>
            <td class="num">${esc(rangesTxt(d.files_indexed))}</td>
            <td class="num">${esc(rangesTxt(d.files_missing || []) || "—")}</td></tr>`).join("")}</tbody></table></div>
        <p class="hint">В базу могут добавляться другие документы; записи разных документов
          о, вероятно, одном человеке связываются в блоке «Возможные упоминания» карточки.</p>`;
      bindRows(app);
      window.scrollTo(0, 0);
    }

    function viewDoc(app, id) {
      const d = R.docById.get(id);
      if (!d) { app.innerHTML = `<p class="empty">Документ ${esc(id)} не найден.</p>`; return; }
      const s = d.stats || {};
      app.innerHTML = `
        <div class="split">
          <div class="left">
            <div class="crumbs"><a href="#/${B.key}/docs">← документы</a></div>
            <h1>${esc(d.title)}</h1>
            <dl class="meta">
              <dt>Тип</dt><dd>${esc(d.type)}</dd>
              <dt>Шифр</dt><dd>${esc(docRef(d))}</dd>
              <dt>Дело</dt><dd>${esc(d.delo_title || "")}</dd>
              <dt>Шапка документа</dt><dd class="orig">${esc(d.header || "")}</dd>
              <dt>Дата</dt><dd>${esc(d.date || d.year)}</dd>
              ${d.prev_year ? `<dt>Прошлая ревизия</dt><dd>${esc(d.prev_year)}</dd>` : ""}
              <dt>${d.kanton ? "Место приписки" : "Ведомство"}</dt><dd>${esc(d.place_reg)}${d.kanton ? ", " + esc(d.kanton) : ""}</dd>
              <dt>Сканы</dt><dd>${d.scans.public_key ? `<a href="${esc(d.scans.public_key)}" target="_blank" rel="noopener">папка на Яндекс Диске</a>`
                : '<span class="muted">пока не выложены</span>'} · документ — файлы ${esc(d.files.join("–"))}</dd>
              <dt>Проиндексировано</dt><dd>${esc(rangesTxt(d.files_indexed))}</dd>
              <dt>Не проиндексировано</dt><dd>${esc(rangesTxt(d.files_missing || []) || "—")}</dd>
              ${d.source && d.source.ref ? `<dt>Первоисточник</dt><dd>${extLink(d.source.ref)}</dd>` : ""}
              ${d.source ? (d.source.notes || []).map((n) => `<dt>Примечание</dt><dd>${esc(n.text)}${n.link ? " " + extLink(n.link) : ""}</dd>`).join("") : ""}
              ${creditTxt(d) ? `<dt>Индексация</dt><dd>${creditTxt(d)}</dd>` : ""}
              <dt>Индекс</dt><dd>${esc(d.source_index)} · импорт ${esc(d.imported)}</dd>
              <dt>Записей</dt><dd>${esc(s.записей || d.records.length)} (мужчин ${esc(s.мужчин || 0)}, женщин ${esc(s.женщин || 0)})${
                Object.entries(s).filter(([k]) => !["записей", "мужчин", "женщин", "с пометками"].includes(k))
                  .map(([k, v]) => `; ${esc(k)} ${esc(v)}`).join("")}</dd>
              <dt>Семей</dt><dd>${d.families.length}</dd>
              <dt class="checks">С пометками</dt><dd class="checks"><a href="#/${B.key}/persons" data-flagged>${esc(s["с пометками"] || 0)} записей</a></dd>
            </dl>
            ${d.index_note ? `<p class="gap-note">${esc(d.index_note)}</p>` : ""}
            <h2>Как считаются годы</h2>
            <ul class="facts">${(d.method || []).map((x) => `<li>${esc(x)}</li>`).join("")}</ul>
            <h2>Колонки индекса</h2>
            <div class="detail"><dl>${Object.entries(d.columns || {}).map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join("")}</dl></div>
          </div>
          <div class="right" data-viewer></div>
        </div>`;
      $("[data-flagged]", app).addEventListener("click", (e) => {
        e.preventDefault();
        Object.assign(ST.pf, PF_RESET, { doc: d.id, flagged: true, sort: "doc", dir: 1 });
        location.hash = `#/${B.key}/persons`;
      });
      mountViewer($("[data-viewer]", app), d, d.files_indexed.slice(0, 1), d.files_indexed[0]);
      window.scrollTo(0, 0);
    }

    /* ================= маршруты ================= */

    // parts — путь после #/<key>/, уже раскодированный. Возвращает вкладку для строки подразделов.
    function route(app, parts, params) {
      const [view, ...rest] = parts;
      const arg = rest.length ? rest.join("/") : null;
      if (view === "persons" && params.q != null) Object.assign(ST.pf, PF_RESET, { q: params.q });
      if (view === "persons" && params.fam != null) Object.assign(ST.pf, PF_RESET, { fam: params.fam });
      const views = {
        persons: () => viewPersons(app), person: () => viewPerson(app, arg),
        families: () => viewFamilies(app), family: () => viewFamily(app, arg),
        surnames: () => viewSurnames(app), docs: () => viewDocs(app), doc: () => viewDoc(app, arg),
      };
      if (!view || !views[view]) return { home: true };
      views[view]();
      const tab = { person: "persons", family: "families", doc: "docs" }[view] || view;
      return { tab };
    }

    return { key: B.key, nav: B.nav, title: B.title, finalize, has, route, homeBlock, bindHomeBlock,
      tabs: () => TABS, _R: R };
  }

  const list = BASES.map(makeBase);
  const loaded = [], links = [];

  function addDoc(d) { loaded.push(d); }
  function addLinks(l) { links.push(...(l || [])); }

  function files(cfg) {
    const f = (cfg.res_docs || []).map((id) => `res_${id}.js`);
    if (cfg.res_links) f.push("res_links.js");
    return f;
  }

  function finalize() {
    list.forEach((b) => b.finalize(loaded.filter((d) => (d.doc.base || "res") === b.key), links));
    loaded.length = 0;
    return list.some((b) => b.has());
  }

  const get = (key) => list.find((b) => b.key === key && b.has()) || null;
  const active = () => list.filter((b) => b.has());

  return { addDoc, addLinks, files, finalize, get, active, all: list };
})();
