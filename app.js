/* Просмотрщик приказов ОКВ. Данные — data_<год>.js, собирает prikaz_explorer.py.
   Страница открывается с диска (file://), поэтому данные подключаются тегами <script>,
   а не fetch: Chrome не даёт file:// читать соседние файлы запросом.

   Годы сводятся в один набор: у каждой страницы, приказа, персоны и упоминания места есть
   год, идентификаторы страниц и приказов — «<год>/<id>». Год — фильтр в каждом справочнике,
   по умолчанию «Все». */

window.OKV = (function () {
  "use strict";

  const S = {
    loaded: [],         // данные годов в порядке загрузки, до сведения
    data: null,         // сведённый набор всех годов
    scroll: {},         // вид → прокрутка, чтобы «назад» возвращал на место
    pf: {               // фильтры персон
      year: "", fam: "", similar: false, name: "", otch: "", place: "", otdel: "", kind: "",
      role: "", grFrom: "", grTo: "", conf: false, sort: "fam", dir: 1, limit: 200,
    },
    sf: { year: "", q: "", similar: false, sort: "alpha", dir: 1, limit: 300 },
    plf: { year: "", q: "", type: "", otdel: "", focus: false, sort: "name", dir: 1, limit: 300 },
    ff: { year: "" },
    tf: { year: "", q: "" },
    vf: { year: "", kind: "", withPersons: false },
  };

  const PF_RESET = { fam: "", similar: false, name: "", otch: "", place: "", otdel: "", kind: "",
    role: "", grFrom: "", grTo: "", conf: false, limit: 200 };

  const KINDS = {
    A_список_семей: "Список семей", B_производство: "Производство",
    C_награды: "Награды", D_персональный: "Персональный", E_исключение: "Исключение",
    F_административный: "Административный", J_судебный: "Судебный",
    K_сословный_переход: "Сословный переход",
  };

  /* ================= нормализация ================= */

  // Старая орфография → современная для сравнения: ъ убираем, ѣ→е, і→и, ѳ→ф, ѵ→и, ё→е.
  const FOLD = { "ъ": "", "ѣ": "е", "і": "и", "ї": "и", "i": "и", "ѳ": "ф", "ѵ": "и", "ё": "е" };

  function fold(s) {
    if (s == null) return "";
    s = String(s).toLowerCase();
    let out = "";
    for (const ch of s) out += (ch in FOLD) ? FOLD[ch] : ch;
    return out;
  }

  // То же, но с картой «индекс в свёрнутом → индекс в исходном» для подсветки.
  function foldMap(s) {
    s = String(s || "");
    const low = s.toLowerCase();
    let text = "";
    const map = [];
    for (let i = 0; i < low.length; i++) {
      const ch = low[i];
      const f = (ch in FOLD) ? FOLD[ch] : ch;
      for (let j = 0; j < f.length; j++) { text += f[j]; map.push(i); }
    }
    return { text, map };
  }

  /* Фонетический ключ фамилии: гласные сведены в классы (а/о, е/и/я/ы, у/ю), согласные —
     по звонкости, мягкий знак и удвоения убраны. Ловит плавающее написание безударных
     гласных — Савенков/Совенков, Агарков/Огарков, Даренских/Доренских, Левин/Ливин —
     и не путает разные фамилии с тем же набором согласных: Кузнецов ≠ Казанцев,
     Дорохов ≠ Горохов. Пары, где плавает больше (Гредусов/Гридасов), задаются явно через «/». */
  const PHON = { "о": "а", "е": "и", "я": "и", "ы": "и", "э": "и", "ю": "у",
    "з": "с", "д": "т", "г": "к", "б": "п", "в": "ф", "ж": "ш", "ь": "", "й": "и" };
  function phonKey(s) {
    let out = "";
    for (const ch of masc(fold(s))) out += (ch in PHON) ? PHON[ch] : ch;
    return out.replace(/[\s\-]/g, "").replace(/(.)\1+/g, "$1");
  }

  // Мужская форма фамилии для сведения: Брагина → брагин, Дмитриевская → дмитриевский.
  function masc(f) {
    if (/(ов|ев|ин|ын)а$/.test(f)) return f.slice(0, -1);
    if (/ская$/.test(f)) return f.slice(0, -2) + "ий";
    if (/цкая$/.test(f)) return f.slice(0, -2) + "ий";
    return f;
  }

  /* Совпадение фамилии с запросом: "exact" | "similar" | null.
     Запрос может нести варианты через «/». Точное — начало слова (мужская и женская
     форма равны), похожее — тот же фонетический ключ. */
  function surnameMatch(query, surname, similar) {
    if (!surname) return null;
    const s = masc(fold(surname));
    let got = null;
    for (const part of String(query).split("/")) {
      const q = masc(fold(part.trim()));
      if (!q) continue;
      if (s === q || s.startsWith(q)) return "exact";
      if (similar && q.length >= 4 && phonKey(s) === phonKey(q)) got = "similar";
    }
    return got;
  }

  const PLACE_PREFIX = /^(пос\.?|посёлок|поселок|выселок|ст\.?|станица|станицы|хутор|село|деревня)\s+/;
  function placeFold(s) {
    return fold(s).replace(PLACE_PREFIX, "").replace(/[,.;]+$/, "").trim();
  }
  // Основа названия места: Тимофеевский/Тимофеевка, Каратабан/Каратабанский, Коркино/Коркинский.
  function placeStem(s) {
    return placeFold(s).replace(/(ская|ский|ской|ского|скую|ское|ка|ое|ый|ая|ий|ой|о|а)$/, "");
  }

  /* ================= данные ================= */

  function addYear(d) { S.loaded.push(d); }

  // Свести загруженные годы в один набор с индексами.
  function finalize() {
    const D = { years: [], pages: [], orders: [], persons: [], places: [], conflicts: [] };
    const placeByKey = new Map();
    for (const d of S.loaded.slice().sort((a, b) => String(a.year).localeCompare(String(b.year)))) {
      const y = String(d.year);
      const uid = (x) => `${y}/${x}`;
      const offset = D.persons.length;
      D.years.push(y);
      for (const p of d.pages) {
        p.year = y; p.rid = p.id; p.id = uid(p.id); p.orders = p.orders.map(uid);
        D.pages.push(p);
      }
      for (const o of d.orders) {
        o.year = y; o.rkey = o.key; o.key = uid(o.key);
        o.fragments.forEach((f) => { f.page = uid(f.page); });
        o.persons = o.persons.map((i) => i + offset);
        D.orders.push(o);
      }
      for (const p of d.persons) {
        p.year = y; p.i += offset; p.page = uid(p.page); p.order = uid(p.order);
        D.persons.push(p);
      }
      for (const pl of d.places) {
        pl.mentions.forEach((m) => { m.page = uid(m.page); m.year = y; });
        const k = JSON.stringify(pl.key);
        const have = placeByKey.get(k);
        if (have) {
          have.mentions.push(...pl.mentions);
          pl.варианты.forEach((v) => { if (!have.варианты.includes(v)) have.варианты.push(v); });
        } else {
          placeByKey.set(k, pl);
          D.places.push(pl);
        }
      }
      (d.conflicts || []).forEach((c) => D.conflicts.push({ year: y, text: c }));
    }
    D.pageById = new Map();
    D.pages.forEach((p, i) => { p.pos = i; D.pageById.set(p.id, p); });
    D.orderByKey = new Map();
    D.orders.forEach((o) => {
      D.orderByKey.set(o.key, o);
      o.pages = [...new Set(o.fragments.map((f) => f.page))];
      const first = D.pageById.get(o.pages[0]);
      o.pos = first ? first.pos : 1e9;
      o.letter = (o.тип || "").charAt(0);
    });
    D.ordersSorted = D.orders.slice().sort((a, b) => a.pos - b.pos);
    D.ordersSorted.forEach((o, i) => { o.seq = i; });
    for (const p of D.persons) {
      const o = D.orderByKey.get(p.order);
      p.letter = o ? o.letter : "";
      p.kind = o ? o.тип : "";
      p._fam = masc(fold(p.фамилия));
      p._name = fold(p.имя);
      p._otch = fold([p.отчество, p.отец].filter(Boolean).join(" "));
      const pl = [p.посёлок, p.станица];
      if (p.откуда) pl.push(p.откуда.посёлок, p.откуда.станица);
      if (p.куда) pl.push(p.куда.посёлок, p.куда.станица);
      p._place = pl.filter(Boolean).map(placeFold).join(" | ");
      p._otdels = [p.отдел, p.откуда && p.откуда.отдел, p.куда && p.куда.отдел]
        .filter(Boolean).map((x) => (String(x).match(/\d+/) || [""])[0]);
      p._page = D.pageById.get(p.page);
    }
    // Фокус места — как в prikaz_places.is_focus(): посёлок или станица в списках фокуса.
    // Ключ места [посёлок, станица, отдел] уже нормализован в нижний регистр при разборе.
    const foc = OKV.focus;
    D.places.forEach((pl, i) => {
      pl.idx = i;
      pl.focus = !!foc && (foc.посёлки.includes(pl.key[0]) || foc.станицы.includes(pl.key[1]));
    });
    S.data = D;
    S.loaded = [];
  }

  const Y = () => S.data;
  const inYear = (x, year) => !year || x.year === year;
  const multiYear = () => Y().years.length > 1;
  // Личный фокус поиска — только в локальной сборке, приходит отдельным необязательным
  // focus.js (см. prikaz_explorer.py write()); в веб-сборке файла нет и вкладка скрыта.
  const hasFocus = () => !!OKV.focus;

  /* ================= помощники вёрстки ================= */

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  }
  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

  function debounce(fn, ms) {
    let t;
    return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
  }

  // Фильтр «Год» — одинаковый во всех справочниках, «Все» по умолчанию.
  function yearSelect(value) {
    return `<label>Год <select data-year><option value="">Все</option>
      ${Y().years.map((y) => `<option${y === value ? " selected" : ""}>${esc(y)}</option>`).join("")}</select></label>`;
  }

  function bindYear(root, st, rerender) {
    const sel = $("[data-year]", root);
    if (sel) sel.addEventListener("change", () => { st.year = sel.value; if ("limit" in st) st.limit = 300; rerender(); });
  }

  function kindPill(kind) {
    if (!kind) return "";
    const L = kind.charAt(0);
    return `<span class="pill kind kind-${esc(L)}" title="${esc(kind)}">${esc(KINDS[kind] || kind)}</span>`;
  }

  function fio(p) {
    const parts = [p.фамилия, p.имя, p.отчество].filter(Boolean);
    return parts.length ? parts.join(" ") : (p.должность || "—");
  }

  function origName(p) {
    const r = p.raw || {};
    const o = [r.фамилия_ориг, r.имя_ориг, r.отчество_ориг].filter(Boolean).join(" ");
    return o && fold(o) !== fold(fio(p)) ? o : "";
  }

  function otdelTxt(x) {
    if (!x) return "";
    const m = String(x).match(/\d+/);
    return m ? m[0] + "-й отд." : String(x);
  }

  function placeTxt(pl) {
    if (!pl) return "";
    const a = [];
    if (pl.посёлок) a.push("пос. " + pl.посёлок);
    if (pl.станица) a.push("ст. " + pl.станица);
    if (pl.отдел) a.push(otdelTxt(pl.отдел));
    return a.join(", ");
  }

  function personPlace(p) {
    const base = placeTxt(p);
    const from = placeTxt(p.откуда), to = placeTxt(p.куда);
    let move = "";
    if (from || to) move = `${esc(from || "?")} → ${esc(to || "?")}`;
    return [base && esc(base), move].filter(Boolean).join("<br>");
  }

  function ageTxt(p) {
    const a = [];
    if (p.лета != null) a.push(p.лета + " л.");
    if (p.г_р) a.push("≈" + p.г_р);
    return a.join(" · ");
  }

  function dateTxt(o) {
    if (o.дата) return fmtDate(o.дата);
    const a = [];
    if (o.дата_не_ранее) a.push("не ранее " + fmtDate(o.дата_не_ранее));
    if (o.дата_не_позднее) a.push("не позднее " + fmtDate(o.дата_не_позднее));
    return a.join(", ");
  }

  function fmtDate(s) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s));
    return m ? `${m[3]}.${m[2]}.${m[1]}` : String(s);
  }

  function orderTitle(o) {
    return o.номер != null ? `№ ${o.номер}` : (o.подтип || o.rkey || o.key);
  }

  // Год рядом с номером приказа — только когда годов в наборе больше одного.
  function yearTag(x) {
    return x && x.year && multiYear() ? ` <span class="muted small">${esc(x.year)}</span>` : "";
  }

  function pageLabel(pg) {
    if (!pg) return "";
    return `с. ${pg.page_no != null ? pg.page_no : "?"}`;
  }

  function splitUid(uid) {
    const i = String(uid).indexOf("/");
    return [uid.slice(0, i), uid.slice(i + 1)];
  }

  /* Сканы: локально — относительные пути на диске, в вебе — Яндекс Диск (config.js
     несёт images). Список файлов года запрашивается один раз в boot(), до первой
     отрисовки (см. loadYearImages) — здесь только синхронный доступ к готовому кэшу. */
  const IMG = { resolved: new Map(), errors: new Set() };

  // Диск отдаёт file/preview по Referer: чужой домен получает 403 — у страницы
  // (index.html) поэтому политика no-referrer, иначе ссылки с 3aharov.github.io не грузятся.
  function loadYearImages(year) {
    const cfg = OKV.config && OKV.config.images;
    if (!cfg) return Promise.resolve();
    const base = "https://cloud-api.yandex.net/v1/disk/public/resources";
    const dir = cfg.pages.replace(/\/$/, "") + "/" + year;
    const map = new Map();
    const page = (offset) => {
      const url = `${base}?public_key=${encodeURIComponent(cfg.public_key)}` +
        `&path=${encodeURIComponent(dir)}&limit=1000&offset=${offset}` +
        `&preview_size=${encodeURIComponent(cfg.preview_size)}` +
        `&fields=_embedded.total,_embedded.items.name,_embedded.items.file,_embedded.items.preview`;
      return fetch(url).then((r) => {
        if (!r.ok) throw new Error("Яндекс.Диск: HTTP " + r.status);
        return r.json();
      }).then((data) => {
        const emb = data._embedded || {};
        const items = emb.items || [];
        for (const it of items) {
          map.set(it.name.replace(/\.png$/i, ""), { file: it.file, preview: it.preview });
        }
        if (items.length && offset + items.length < (emb.total || 0)) return page(offset + items.length);
      });
    };
    return page(0).then(() => { IMG.resolved.set(year, map); })
      .catch((e) => { IMG.errors.add(year); console.error("Сканы года", year, "недоступны:", e); });
  }

  function imgSrc(uid) {
    const [y, id] = splitUid(uid);
    if (!(OKV.config && OKV.config.images)) return `../pages/${y}/${encodeURIComponent(id)}.png`;
    const e = IMG.resolved.get(y) && IMG.resolved.get(y).get(id);
    return e ? e.file : null;
  }
  function thumbSrc(uid) {
    const [y, id] = splitUid(uid);
    if (!(OKV.config && OKV.config.images)) return `../thumbs/${y}/${encodeURIComponent(id)}.png`;
    const e = IMG.resolved.get(y) && IMG.resolved.get(y).get(id);
    return e ? e.preview : null;
  }
  /* Ссылка на исходный (неразрезанный) разворот. Локально — относительный путь на диск
     корпуса; в вебе — суффикс пути к публичной ссылке на корень корпуса (corpus_key),
     без обращения к API: Яндекс.Диск сам открывает файл по пути внутри публичной папки.
     corpus_key — не то же самое, что public_key (тот со временем сузится до _work\pages,
     видеть корень корпуса он может перестать). Без corpus_key в вебе ссылки нет вовсе. */
  function origHref(orig) {
    const cfg = OKV.config && OKV.config.images;
    const seg = orig.split("/").map(encodeURIComponent).join("/");
    if (!cfg) return "../../" + seg;
    return cfg.corpus_key ? cfg.corpus_key + "/" + seg : null;
  }
  const rid = (uid) => splitUid(uid)[1];

  function orderHref(key, personI) {
    return `#/order/${encodeURIComponent(key)}` + (personI != null ? `?p=${personI}` : "");
  }
  const pageHref = (uid) => `#/page/${encodeURIComponent(uid)}`;

  // Упоминание места хранит номер приказа и страницу — ключ приказа находим по ним.
  function orderForMention(m) {
    const pg = Y().pageById.get(m.page);
    if (!pg) return null;
    for (const key of pg.orders) {
      const o = Y().orderByKey.get(key);
      if (o && m.номер != null && o.номер === m.номер) return o;
    }
    return pg.orders.length === 1 ? Y().orderByKey.get(pg.orders[0]) : null;
  }

  function dl(obj, skip) {
    const rows = [];
    for (const [k, v] of Object.entries(obj || {})) {
      if (skip && skip.has(k)) continue;
      if (v == null || v === "" || (Array.isArray(v) && !v.length)) continue;
      let val;
      if (typeof v === "object") val = `<code>${esc(JSON.stringify(v, null, 0))}</code>`;
      else val = esc(v);
      rows.push(`<dt>${esc(k)}</dt><dd>${val}</dd>`);
    }
    return rows.length ? `<dl>${rows.join("")}</dl>` : "";
  }

  function sortHead(cols, st) {
    return "<tr>" + cols.map(([key, label]) => {
      if (!key) return `<th class="nosort">${label}</th>`;
      // Стрелка показывает смысл порядка, а не знак: у числа упоминаний «прямой» порядок — по убыванию.
      const down = key === "count" ? st.dir > 0 : st.dir < 0;
      const dir = st.sort === key ? `<span class="dir">${down ? "▼" : "▲"}</span>` : "";
      return `<th data-sort="${key}">${label} ${dir}</th>`;
    }).join("") + "</tr>";
  }

  function bindSort(root, st, rerender) {
    $$("th[data-sort]", root).forEach((th) => th.addEventListener("click", () => {
      const k = th.dataset.sort;
      if (st.sort === k) st.dir = -st.dir; else { st.sort = k; st.dir = 1; }
      rerender();
    }));
  }

  /* ================= просмотр скана ================= */

  // Откуда просмотр берёт сканы. По умолчанию — страницы приказов; база жителей
  // (res.js) передаёт свой источник с теми же методами.
  const okvSource = {
    label: (pid) => pageLabel(Y().pageById.get(pid)),
    img: imgSrc,
    orig: (pid) => {
      const pg = Y().pageById.get(pid);
      const href = pg && pg.orig ? origHref(pg.orig) : null;
      return href ? { href, title: pg.orig, text: "Разворот" } : null;
    },
    missing: (pid) => (IMG.errors.has(splitUid(pid)[0]) ? "Сканы недоступны" : "Скан не найден: " + pid),
  };

  /* Скан с увеличением и перетаскиванием. show(id, person) — открыть страницу и, если
     у персоны есть координаты (prikaz_ocr.py), подсветить её строку и подвести к ней. */
  function viewer(host, pageIds, activeId, activePerson, source) {
    const src = source || okvSource;
    let id = activeId || pageIds[0];
    let pending = activePerson || null;
    host.innerHTML = `
      <div class="viewer">
        <div class="viewer-bar">
          <span class="chips" data-chips></span>
          <span class="grow"></span>
          <span class="muted small" data-hlnote></span>
          <button data-z="-" title="Уменьшить">−</button>
          <button data-z="fit" title="По ширине (двойной щелчок)">По ширине</button>
          <button data-z="+" title="Увеличить">+</button>
          <a data-orig target="_blank" rel="noopener" title="Исходный разворот — если поле обрезано разрезом">Разворот</a>
        </div>
        <div class="stage" data-stage>
          <div class="canvas" data-canvas><img data-img alt=""><div class="hl" data-hl hidden></div><div class="hl-word" data-hlw hidden></div></div>
          <div class="noimg" data-noimg hidden></div>
        </div>
      </div>`;
    const stage = $("[data-stage]", host);
    const canvas = $("[data-canvas]", host);
    const img = $("[data-img]", host);
    const hl = $("[data-hl]", host), hlw = $("[data-hlw]", host);
    const note = $("[data-hlnote]", host);
    let scale = 1, tx = 0, ty = 0;

    const apply = () => { canvas.style.transform = `translate(${tx}px,${ty}px) scale(${scale})`; };
    const fitScale = () => (img.naturalWidth ? stage.clientWidth / img.naturalWidth : 1);
    const fit = () => { scale = fitScale(); tx = 0; ty = 0; apply(); };
    const zoomAt = (factor, cx, cy) => {
      const ns = Math.min(8, Math.max(0.15, scale * factor));
      tx = cx - (cx - tx) * (ns / scale);
      ty = cy - (cy - ty) * (ns / scale);
      scale = ns; apply();
    };

    const place = (el, b) => {
      const W = img.naturalWidth, H = img.naturalHeight, pad = 0.004;
      el.style.left = (b[0] - pad) * W + "px";
      el.style.top = (b[1] - pad) * H + "px";
      el.style.width = (b[2] + 2 * pad) * W + "px";
      el.style.height = (b[3] + 2 * pad) * H + "px";
      el.hidden = false;
    };

    function highlight(p) {
      hl.hidden = true; hlw.hidden = true; note.textContent = "";
      if (!p || !img.naturalWidth) return;
      if (!p.box) { note.textContent = "строка не найдена на скане"; fit(); return; }
      place(hl, p.box);
      if (p.wbox) place(hlw, p.wbox);
      // Строку — на треть высоты окна, по ширине с небольшим увеличением к слову.
      scale = fitScale() * 1.5;
      const W = img.naturalWidth, H = img.naturalHeight;
      const cx = ((p.wbox || p.box)[0] + (p.wbox || p.box)[2] / 2) * W;
      const cy = (p.box[1] + p.box[3] / 2) * H;
      tx = Math.min(0, Math.max(stage.clientWidth - W * scale, stage.clientWidth / 2 - cx * scale));
      ty = stage.clientHeight / 3 - cy * scale;
      apply();
    }

    function show(newId, person) {
      pending = person || null;
      const newSrc = src.img(newId);
      const same = newId === id && img.naturalWidth && newSrc && img.src.endsWith(newSrc.replace(/^\.\.\//, ""));
      id = newId;
      $("[data-chips]", host).innerHTML = pageIds.map((pid) =>
        `<button class="chip ${pid === id ? "on" : ""}" data-pid="${esc(pid)}" title="${esc(pid)}">${esc(src.label(pid))}</button>`).join("");
      $$("[data-pid]", host).forEach((b) => b.addEventListener("click", () => show(b.dataset.pid)));
      const orig = $("[data-orig]", host);
      const o = src.orig(id);
      if (o) { orig.href = o.href; orig.hidden = false; orig.title = o.title; orig.textContent = o.text; }
      else orig.hidden = true;
      if (same) {
        if (pending) highlight(pending); else { hl.hidden = true; hlw.hidden = true; note.textContent = ""; }
        return;
      }
      hl.hidden = true; hlw.hidden = true; note.textContent = "";
      // В вебе список сканов года мог не отдаться (сеть) или не найтись файл — тогда
      // imgSrc возвращает null, картинку даже не пробуем грузить.
      if (!newSrc) {
        canvas.hidden = true;
        const box = $("[data-noimg]", host);
        box.textContent = src.missing(id);
        box.hidden = false;
        return;
      }
      $("[data-noimg]", host).hidden = true;
      canvas.hidden = false;
      img.onload = () => {
        canvas.style.width = img.naturalWidth + "px";
        canvas.style.height = img.naturalHeight + "px";
        if (pending) highlight(pending); else fit();
      };
      img.onerror = () => {
        canvas.hidden = true;
        const box = $("[data-noimg]", host);
        box.textContent = "Скан не найден: " + newSrc;
        box.hidden = false;
      };
      img.src = newSrc;
    }

    $$("[data-z]", host).forEach((b) => b.addEventListener("click", () => {
      const z = b.dataset.z;
      if (z === "fit") fit();
      else zoomAt(z === "+" ? 1.25 : 0.8, stage.clientWidth / 2, stage.clientHeight / 2);
    }));
    stage.addEventListener("wheel", (e) => {
      e.preventDefault();
      const r = stage.getBoundingClientRect();
      zoomAt(e.deltaY < 0 ? 1.15 : 1 / 1.15, e.clientX - r.left, e.clientY - r.top);
    }, { passive: false });
    let drag = null;
    stage.addEventListener("pointerdown", (e) => {
      drag = { x: e.clientX, y: e.clientY, tx, ty };
      stage.setPointerCapture(e.pointerId); stage.classList.add("drag");
    });
    stage.addEventListener("pointermove", (e) => {
      if (!drag) return;
      tx = drag.tx + e.clientX - drag.x; ty = drag.ty + e.clientY - drag.y; apply();
    });
    const end = () => { drag = null; stage.classList.remove("drag"); };
    stage.addEventListener("pointerup", end);
    stage.addEventListener("pointercancel", end);
    stage.addEventListener("dblclick", (e) => {
      const r = stage.getBoundingClientRect();
      if (scale > fitScale() * 1.05) fit(); else zoomAt(2.2, e.clientX - r.left, e.clientY - r.top);
    });

    show(id, pending);
    return { show };
  }

  /* ================= Главная сайта и страница раздела «Приказы ОКВ» ================= */

  const hasOkv = () => Y().years.length > 0;
  const hasRes = () => !!(OKV.res && OKV.res.has());

  function okvYears() {
    const D = Y();
    return D.years.length > 1 ? `${D.years[0]}–${D.years[D.years.length - 1]}` : D.years[0];
  }

  function yearsIndexed() {
    return Y().years.length > 1 ? `Индексированы ${esc(okvYears())} годы.` : `Индексирован только ${esc(okvYears())} год.`;
  }

  // Формы поиска приказов (фамилия, место) — на главной сайта и на странице раздела.
  function okvSearchForms(prefix) {
    return `
      <form data-home="surnames">
        <label for="${prefix}-surname">Поиск по фамилиям</label>
        <div class="row">
          <input id="${prefix}-surname" type="search" placeholder="например, Захаров" autocomplete="off">
          <button class="primary" type="submit">Найти</button>
        </div>
        <span class="hint">Фамилия по началу; женская форма равна мужской, старая орфография учтена.</span>
      </form>
      <form data-home="places">
        <label for="${prefix}-place">Поиск по населённым пунктам</label>
        <div class="row">
          <input id="${prefix}-place" type="search" placeholder="например, Еманжелинский" autocomplete="off">
          <button class="primary" type="submit">Найти</button>
        </div>
        <span class="hint">Посёлок или станица, по части названия.</span>
      </form>`;
  }

  function bindOkvSearch(root) {
    $$("form[data-home]", root).forEach((form) => form.addEventListener("submit", (e) => {
      e.preventDefault();
      const value = $("input", form).value.trim();
      // Как будто значение введено в строку поиска нужного справочника; остальные фильтры — по умолчанию.
      if (form.dataset.home === "surnames") {
        Object.assign(S.sf, { q: value, similar: false, limit: 300 });
        S.scroll.surnames = 0;
        location.hash = "#/surnames";
      } else {
        Object.assign(S.plf, { q: value, type: "", otdel: "", focus: false, limit: 300 });
        S.scroll.places = 0;
        location.hash = "#/places";
      }
    }));
  }

  // Как собраны данные приказов — раскрывающимся блоком на главной.
  const OKV_FACTS = `
    <details class="howto"><summary>Как собраны данные</summary>
      <ul class="facts">
        <li>Источник — фотографии листов печатных приказов по Оренбургскому казачьему войску. Каждая
          страница разобрана по полноразмерному скану: приказы, люди, места и события записаны
          в структурированном виде.</li>
        <li>Тексты приказов приводятся буква в букву, в старой орфографии. В указателях орфография
          современная, написание источника показано рядом.</li>
        <li>Нечитаемое не достраивается: сомнительные чтения помечены, у приказа всегда есть ссылка на скан.</li>
        <li>Место — это наименование, станица и отдел вместе: одинаковое название в разных станицах — разные места.
          Варианты написания одного пункта сведены только там, где это подтверждает текст приказа.</li>
        <li>Строка человека на скане находится автоматически и может ошибаться. Любой вывод сверяйте по скану.</li>
      </ul>
    </details>`;

  function viewHome(app) {
    const D = Y();
    const okv = hasOkv() ? `
      <section class="base panel">
        <h2>Приказы по Оренбургскому казачьему войску</h2>
        <p>Поисковый указатель к печатным приказам по ОКВ: люди, фамилии и населённые пункты
          со ссылкой на приказ и на скан страницы. ${yearsIndexed()}</p>
        <p class="base-stats"><b>${D.persons.length}</b> упоминаний людей · <b>${D.orders.length}</b> приказов ·
          <b>${surnameGroups("").length}</b> фамилий · <b>${D.places.length}</b> населённых пунктов ·
          <b>${D.pages.length}</b> страниц разобрано</p>
        <div class="home-search">${okvSearchForms("home")}</div>
        ${OKV_FACTS}
      </section>` : "";
    const res = hasRes() ? OKV.res.homeBlock() : "";
    app.innerHTML = `
      <section class="home">
        <div class="hero">
          <h1>Указатели по генеалогии и локальной истории</h1>
          <p class="lead">Поисковые базы по документам о казаках Оренбургского казачьего войска:
            кто, где и когда упомянут, со ссылкой на скан источника.</p>
          <p class="lead">Проект находится в стадии тестирования.</p>
          <p class="lead">Часть авторского проекта <a href="https://t.me/alexzakhar" target="_blank" rel="noopener">Саши Захарова</a>
            по генеалогии и локальной истории.</p>
        </div>
        <div class="bases">${res}${okv}</div>
      </section>`;
    bindOkvSearch(app);
    if (hasRes()) OKV.res.bindHomeBlock(app);
    const first = $("input[type=search]", app);
    if (first) first.focus();
  }

  /* ================= Персоны ================= */

  function filterPersons(f) {
    const res = [];
    const grFrom = parseInt(f.grFrom, 10), grTo = parseInt(f.grTo, 10);
    const name = fold(f.name.trim()), otch = fold(f.otch.trim()), place = placeFold(f.place.trim());
    for (const p of Y().persons) {
      if (!inYear(p, f.year)) continue;
      let match = "";
      if (f.fam.trim()) {
        match = surnameMatch(f.fam, p.фамилия, f.similar);
        if (!match) continue;
      }
      if (name && !p._name.startsWith(name)) continue;
      if (otch && !p._otch.includes(otch)) continue;
      if (place && !p._place.includes(place)) continue;
      if (f.otdel && !p._otdels.includes(f.otdel)) continue;
      if (f.kind && p.kind !== f.kind) continue;
      if (f.role && p.role !== f.role) continue;
      if (!isNaN(grFrom) && !(p.г_р >= grFrom)) continue;
      if (!isNaN(grTo) && !(p.г_р <= grTo)) continue;
      if (f.conf && p.conf === "low") continue;
      res.push({ p, match });
    }
    const dir = f.dir;
    const o = (p) => Y().orderByKey.get(p.order);
    const cmp = {
      fam: (a, b) => (!a.p._fam - !b.p._fam) ||
        (a.p._fam + " " + a.p._name).localeCompare(b.p._fam + " " + b.p._name, "ru"),
      gr: (a, b) => (a.p.г_р || 9999) - (b.p.г_р || 9999),
      place: (a, b) => a.p._place.localeCompare(b.p._place, "ru"),
      date: (a, b) => String(a.p.дата || "").localeCompare(String(b.p.дата || "")),
      order: (a, b) => ((o(a.p) || {}).seq || 0) - ((o(b.p) || {}).seq || 0) || a.p.i - b.p.i,
    }[f.sort] || (() => 0);
    res.sort((a, b) => {
      if (a.match !== b.match) return a.match === "exact" ? -1 : b.match === "exact" ? 1 : 0;
      return cmp(a, b) * dir;
    });
    return res;
  }

  function viewPersons(app) {
    const f = S.pf;
    const roles = [...new Set(Y().persons.map((p) => p.role).filter(Boolean))].sort();
    app.innerHTML = `
      <div class="panel">
        <div class="filters">
          ${yearSelect(f.year)}
          <label>Фамилия <input type="search" data-f="fam" placeholder="Захаров или Гредусов/Гридасов"></label>
          <label>Имя <input type="search" data-f="name"></label>
          <label>Отчество или имя отца <input type="search" data-f="otch"></label>
          <label>Место (посёлок, станица, переходы) <input type="search" data-f="place"></label>
          <label>Отдел <select data-f="otdel"><option value="">любой</option>
            <option value="1">1-й</option><option value="2">2-й</option><option value="3">3-й</option></select></label>
          <label>Вид приказа <select data-f="kind"><option value="">любой</option>
            ${Object.entries(KINDS).map(([k, v]) => `<option value="${k}">${v}</option>`).join("")}</select></label>
          <label>Роль <select data-f="role"><option value="">любая</option>
            ${roles.map((r) => `<option>${esc(r)}</option>`).join("")}</select></label>
          <label>Год рождения (расчётный) <span class="pair">
            <input type="number" data-f="grFrom" placeholder="от"><input type="number" data-f="grTo" placeholder="до"></span></label>
          <label class="check"><input type="checkbox" data-f="similar"> похожие написания фамилии</label>
          <label class="check"><input type="checkbox" data-f="conf"> без сомнительных (conf: low)</label>
        </div>
      </div>
      <div class="toolbar">
        <span data-count class="count"></span><span class="grow"></span>
        <span class="hint">Фамилия ищется по началу, женская форма равна мужской. Старая орфография учтена.</span>
        <button data-reset>Сбросить</button>
      </div>
      <div data-results></div>`;

    bindYear(app, f, () => { f.limit = 200; draw(); });
    $$("[data-f]", app).forEach((el) => {
      const k = el.dataset.f;
      if (el.type === "checkbox") el.checked = !!f[k]; else el.value = f[k];
      const upd = () => { f[k] = el.type === "checkbox" ? el.checked : el.value; f.limit = 200; draw(); };
      el.addEventListener(el.tagName === "SELECT" || el.type === "checkbox" ? "change" : "input",
        el.tagName === "INPUT" && el.type !== "checkbox" ? debounce(upd, 150) : upd);
    });
    $("[data-reset]", app).addEventListener("click", () => {
      Object.assign(f, PF_RESET, { year: "" });
      viewPersons(app);
    });

    function draw() {
      const res = filterPersons(f);
      const similarN = res.filter((r) => r.match === "similar").length;
      $("[data-count]", app).textContent = `Найдено: ${res.length}` +
        (similarN ? ` (из них похожих написаний: ${similarN})` : "");
      const box = $("[data-results]", app);
      if (!res.length) { box.innerHTML = `<p class="empty">Ничего не найдено.</p>`; return; }
      const rows = res.slice(0, f.limit).map(({ p, match }) => {
        const o = Y().orderByKey.get(p.order) || {};
        const orig = origName(p);
        return `<tr data-href="${esc(orderHref(p.order, p.i))}">
          <td><span class="name">${esc(fio(p))}</span>
            ${match === "similar" ? ` <span class="pill tag-similar">похоже</span>` : ""}
            ${p.conf === "low" ? ` <span class="pill conf-low">сомн.</span>` : ""}
            ${orig ? `<div class="orig">${esc(orig)}</div>` : ""}</td>
          <td>${esc(p.звание || "")}${p.звание_новое ? ` → ${esc(p.звание_новое)}` : ""}
            ${p.role && p.role !== "персона" ? `<div class="muted small">${esc(p.role)}</div>` : ""}</td>
          <td class="num">${esc(ageTxt(p))}</td>
          <td>${personPlace(p)}</td>
          <td class="ev">${esc((p.событие || "").slice(0, 140))}${(p.событие || "").length > 140 ? "…" : ""}</td>
          <td class="num">${esc(p.дата ? fmtDate(p.дата) : "")}</td>
          <td class="nowrap">${kindPill(o.тип)}<div>${esc(orderTitle(o))}${yearTag(o)}</div></td>
          <td class="num">${esc(pageLabel(p._page))}</td>
        </tr>`;
      }).join("");
      box.innerHTML = `<div class="tablewrap"><table class="grid">
        <thead>${sortHead([["fam", "Фамилия, имя, отчество"], ["", "Звание / роль"], ["gr", "Лета / г. р."],
          ["place", "Место"], ["", "Событие"], ["date", "Дата"], ["order", "Приказ"], ["", "Стр."]], f)}</thead>
        <tbody>${rows}</tbody></table></div>
        ${res.length > f.limit ? `<div class="more"><button data-more>Показать ещё (${res.length - f.limit})</button></div>` : ""}`;
      bindRows(box);
      bindSort(box, f, draw);
      const more = $("[data-more]", box);
      if (more) more.addEventListener("click", () => { f.limit += 500; draw(); });
    }
    draw();
  }

  function bindRows(root) {
    $$("tr[data-href]", root).forEach((tr) => tr.addEventListener("click", (e) => {
      if (e.target.closest("a")) return;
      location.hash = tr.dataset.href;
    }));
  }

  /* ================= Приказ ================= */

  function personRows(ids, activeI) {
    const persons = ids.map((i) => Y().persons[i]);
    const hasYards = persons.some((p) => p.двор != null);
    let lastYard = undefined;
    const out = [];
    for (const p of persons) {
      if (hasYards && p.двор !== lastYard) {
        lastYard = p.двор;
        const head = persons.find((x) => x.двор === p.двор && x.role === "глава_семьи");
        out.push(`<tr class="group"><td colspan="7">${p.двор != null ? "Двор " + esc(p.двор) : "Вне дворов"}${head ? " — " + esc(fio(head)) : ""}</td></tr>`);
      }
      const orig = origName(p);
      out.push(`<tr data-person="${p.i}" class="${p.i === activeI ? "active" : ""}">
        <td class="num">${esc(p.raw.номер_в_списке || p.raw.n || "")}</td>
        <td><span class="name">${esc(fio(p))}</span>
          ${p.conf && p.conf !== "high" ? ` <span class="pill conf-${esc(p.conf)}">${esc(p.conf)}</span>` : ""}
          ${p.box ? "" : ` <span class="pill muted" title="строка на скане не найдена автоматически">нет на скане</span>`}
          ${orig ? `<div class="orig">${esc(orig)}</div>` : ""}</td>
        <td>${esc(p.role || "")}</td>
        <td>${esc(p.звание || "")}${p.звание_новое ? ` → ${esc(p.звание_новое)}` : ""}</td>
        <td class="num">${esc(ageTxt(p))}</td>
        <td>${personPlace(p)}</td>
        <td class="ev">${esc(p.событие || "")}</td>
      </tr>`);
    }
    return out.join("");
  }

  const RAW_SKIP = new Set(["n"]);

  function toggleDetail(tr, force) {
    const next = tr.nextElementSibling;
    const open = next && next.classList.contains("detail-row");
    if (open && force !== true) { next.remove(); return; }
    if (open) return;
    const p = Y().persons[+tr.dataset.person];
    const row = document.createElement("tr");
    row.className = "detail-row";
    row.innerHTML = `<td colspan="7"><div class="detail">${dl(p.raw, RAW_SKIP)}
      <div class="small muted" style="margin-top:6px">Страница ${esc(rid(p.page))} · ${esc(pageLabel(p._page))} · ${esc(p.year)}</div></div></td>`;
    tr.after(row);
  }

  function viewOrder(app, key, params) {
    const o = Y().orderByKey.get(key);
    if (!o) { app.innerHTML = `<p class="empty">Приказ ${esc(key)} не найден.</p>`; return; }
    const activeI = params.p != null ? +params.p : null;
    const activeP = activeI != null ? Y().persons[activeI] : null;
    const prev = Y().ordersSorted[o.seq - 1], next = Y().ordersSorted[o.seq + 1];

    const text = o.fragments.map((fr) => {
      const pg = Y().pageById.get(fr.page);
      return `<span class="pagebreak" data-goto="${esc(fr.page)}">${esc(pageLabel(pg))} · ${esc(rid(fr.page))}</span>${fr.текст ? esc(fr.текст) : '<span class="muted">(текст на этой странице не записан)</span>'}`;
    }).join("");

    const extra = o.fragments.map((fr) => {
      const pg = Y().pageById.get(fr.page) || {};
      const body = dl(fr.extra) + (pg.note ? `<p class="small"><b>Заметка страницы:</b> ${esc(pg.note)}</p>` : "") +
        (pg.flags && pg.flags.length ? `<div class="flags">${pg.flags.map((x) => `<code>${esc(x)}</code>`).join("")}</div>` : "");
      return body ? `<h3><a href="${pageHref(fr.page)}">${esc(pageLabel(pg))} · ${esc(rid(fr.page))}</a></h3>${body}` : "";
    }).join("");

    const signs = o.подписи.map((s) => typeof s === "object"
      ? `<li>${esc(s.роль || "")}: ${esc([s.звание, s.фамилия].filter(Boolean).join(" "))}${s.должность ? ", " + esc(s.должность) : ""}${s.где ? ` <span class="muted">(${esc(s.где)})</span>` : ""}</li>`
      : `<li>${esc(s)}</li>`).join("");

    const places = o.места.map((m) => `<div class="detail">${dl(m)}</div>`).join("");

    app.innerHTML = `
      <div class="split">
        <div class="left">
          <div class="crumbs">
            <a href="javascript:history.back()">← назад</a><span class="sep">|</span>
            ${prev ? `<a href="${esc(orderHref(prev.key))}">‹ ${esc(orderTitle(prev))}</a>` : ""}
            ${next ? `<a href="${esc(orderHref(next.key))}">${esc(orderTitle(next))} ›</a>` : ""}
          </div>
          <h1>Приказ ${esc(orderTitle(o))}${dateTxt(o) ? ` <span class="muted">· ${esc(dateTxt(o))}</span>` : ""}</h1>
          <div>${kindPill(o.тип)} <span class="muted">${esc(o.подтип || "")}</span></div>
          <dl class="meta">
            <dt>Год</dt><dd>${esc(o.year)}</dd>
            ${o.ведомство ? `<dt>Ведомство</dt><dd>${esc(o.ведомство)}</dd>` : ""}
            ${o.место_издания ? `<dt>Место издания</dt><dd>${esc(o.место_издания)}</dd>` : ""}
            ${o.основание.length ? `<dt>Основание</dt><dd>${o.основание.map((x) => esc(typeof x === "object" ? JSON.stringify(x) : x)).join("<br>")}</dd>` : ""}
            <dt>Ключ</dt><dd><code>${esc(o.rkey)}</code></dd>
            <dt>Страницы</dt><dd>${o.pages.map((pid) => `<a href="${pageHref(pid)}">${esc(pageLabel(Y().pageById.get(pid)))}</a>`).join(", ")}</dd>
          </dl>
          <h2>Текст</h2>
          <div class="source">${text}</div>
          ${o.persons.length ? `<h2>Персоны <span class="count">${o.persons.length}</span></h2>
            <p class="hint">Щелчок по строке — всё, что записал разбор; скан переходит на страницу персоны и подсвечивает её строку.</p>
            <div class="tablewrap"><table class="grid">
              <thead><tr><th class="nosort">№</th><th class="nosort">ФИО</th><th class="nosort">Роль</th><th class="nosort">Звание</th><th class="nosort">Лета / г. р.</th><th class="nosort">Место</th><th class="nosort">Событие</th></tr></thead>
              <tbody>${personRows(o.persons, activeI)}</tbody></table></div>` : ""}
          ${places ? `<h2>Населённые пункты</h2>${places}` : ""}
          ${signs ? `<h2>Подписи</h2><ul>${signs}</ul>` : ""}
          ${extra ? `<h2>Прочее из разбора</h2>${extra}` : ""}
        </div>
        <div class="right" data-viewer></div>
      </div>`;

    const v = viewer($("[data-viewer]", app), o.pages, activeP ? activeP.page : o.pages[0], activeP);
    $$("[data-goto]", app).forEach((el) => el.addEventListener("click", () => v.show(el.dataset.goto)));
    $$("tr[data-person]", app).forEach((tr) => tr.addEventListener("click", () => {
      $$("tr.active", app).forEach((x) => x.classList.remove("active"));
      tr.classList.add("active");
      toggleDetail(tr);
      const pp = Y().persons[+tr.dataset.person];
      v.show(pp.page, pp);
    }));
    const act = activeI != null && $(`tr[data-person="${activeI}"]`, app);
    if (act) {
      toggleDetail(act, true);
      // Прокручиваем только окно: scrollIntoView сдвигает и контейнер таблицы.
      window.scrollTo(0, Math.max(0, act.getBoundingClientRect().top + window.scrollY - window.innerHeight / 3));
    } else window.scrollTo(0, 0);
  }

  /* ================= Страница ================= */

  function viewPage(app, id) {
    const pg = Y().pageById.get(id);
    if (!pg) { app.innerHTML = `<p class="empty">Страница ${esc(id)} не найдена.</p>`; return; }
    const prev = Y().pages[pg.pos - 1], next = Y().pages[pg.pos + 1];
    const orders = pg.orders.map((key) => {
      const o = Y().orderByKey.get(key);
      const fr = o.fragments.find((f) => f.page === id) || {};
      const n = o.persons.filter((i) => Y().persons[i].page === id).length;
      return `<li><a href="${esc(orderHref(key))}"><b>${esc(orderTitle(o))}</b></a> ${kindPill(o.тип)}
        <span class="muted">${esc(dateTxt(o))}${n ? ` · персон на странице: ${n}` : ""}</span>
        <div class="muted small">${esc(o.подтип || "")}</div>
        ${fr.текст ? `<div class="snip">${esc(fr.текст.slice(0, 320))}${fr.текст.length > 320 ? "…" : ""}</div>` : ""}</li>`;
    }).join("");
    app.innerHTML = `
      <div class="split">
        <div class="left">
          <div class="crumbs">
            <a href="#/volume">← том</a><span class="sep">|</span>
            ${prev ? `<a href="${pageHref(prev.id)}">‹ ${esc(pageLabel(prev))}${prev.year !== pg.year ? " · " + esc(prev.year) : ""}</a>` : ""}
            ${next ? `<a href="${pageHref(next.id)}">${esc(pageLabel(next))}${next.year !== pg.year ? " · " + esc(next.year) : ""} ›</a>` : ""}
          </div>
          <h1>Страница ${esc(pg.page_no != null ? pg.page_no : "?")} <span class="muted">· ${esc(pg.year)} · серия ${esc(pg.series)}</span></h1>
          <div>${kindPill(pg.kind)} <code>${esc(pg.rid)}</code> <span class="muted small">${esc(pg.orig || pg.scan)}</span></div>
          ${pg.note ? `<p>${esc(pg.note)}</p>` : ""}
          ${pg.flags.length ? `<div class="flags">${pg.flags.map((x) => `<code>${esc(x)}</code>`).join("")}</div>` : ""}
          <h2>Приказы на странице</h2>
          <ul class="hitlist">${orders}</ul>
        </div>
        <div class="right" data-viewer></div>
      </div>`;
    viewer($("[data-viewer]", app), [id], id);
    window.scrollTo(0, 0);
  }

  /* ================= Фамилии ================= */

  const surnameCache = new Map();

  function surnameGroups(year) {
    if (surnameCache.has(year)) return surnameCache.get(year);
    const persons = Y().persons.filter((p) => inYear(p, year) && p.фамилия);
    const keys = new Set(persons.map((p) => fold(p.фамилия)));
    const groups = new Map();
    for (const p of persons) {
      const f = fold(p.фамилия);
      let key = masc(f);
      if (!keys.has(key)) key = f;
      let g = groups.get(key);
      if (!g) groups.set(key, g = { key, names: new Map(), origs: new Map(), places: new Map(), n: 0, gr: [] });
      g.n++;
      const isMasc = key === f;
      g.names.set(p.фамилия, (g.names.get(p.фамилия) || 0) + (isMasc ? 2 : 1));
      if (p.фамилия_ориг) g.origs.set(p.фамилия_ориг, (g.origs.get(p.фамилия_ориг) || 0) + 1);
      const pl = p.посёлок || p.станица || (p.откуда && (p.откуда.посёлок || p.откуда.станица));
      if (pl) g.places.set(pl, (g.places.get(pl) || 0) + 1);
      if (p.г_р) g.gr.push(p.г_р);
    }
    const top = (m, n) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map((x) => x[0]);
    const list = [...groups.values()].map((g) => ({
      key: g.key, name: top(g.names, 1)[0], n: g.n, origs: top(g.origs, 4),
      places: top(g.places, 3),
      gr: g.gr.length ? [Math.min(...g.gr), Math.max(...g.gr)] : null,
    }));
    surnameCache.set(year, list);
    return list;
  }

  function viewSurnames(app) {
    const f = S.sf;
    app.innerHTML = `
      <div class="panel"><div class="filters">
        ${yearSelect(f.year)}
        <label>Фамилия <input type="search" data-q placeholder="начало фамилии"></label>
        <label class="check"><input type="checkbox" data-sim> похожие написания</label>
      </div></div>
      <div class="toolbar"><span class="count" data-count></span><span class="grow"></span>
        <span class="hint">Женские формы сведены к мужской. Щелчок — все упоминания.</span></div>
      <div data-results></div>`;
    const q = $("[data-q]", app), sim = $("[data-sim]", app);
    q.value = f.q; sim.checked = f.similar;
    bindYear(app, f, draw);
    q.addEventListener("input", debounce(() => { f.q = q.value; f.limit = 300; draw(); }, 150));
    sim.addEventListener("change", () => { f.similar = sim.checked; draw(); });

    function draw() {
      let list = surnameGroups(f.year).map((g) => ({ g, m: f.q.trim() ? surnameMatch(f.q, g.name, f.similar) : "exact" }))
        .filter((x) => x.m);
      const cmp = f.sort === "alpha"
        ? (a, b) => a.g.key.localeCompare(b.g.key, "ru") * f.dir
        : (a, b) => (b.g.n - a.g.n) * f.dir || a.g.key.localeCompare(b.g.key, "ru");
      list.sort((a, b) => (a.m === b.m ? 0 : a.m === "exact" ? -1 : 1) || cmp(a, b));
      $("[data-count]", app).textContent = `Фамилий: ${list.length}`;
      const box = $("[data-results]", app);
      if (!list.length) { box.innerHTML = `<p class="empty">Ничего не найдено.</p>`; return; }
      const rows = list.slice(0, f.limit).map(({ g, m }) => `
        <tr data-name="${esc(g.name)}">
          <td><span class="name">${esc(g.name)}</span>${m === "similar" ? ` <span class="pill tag-similar">похоже</span>` : ""}</td>
          <td class="num">${g.n}</td>
          <td class="orig">${esc(g.origs.join(", "))}</td>
          <td>${esc(g.places.join(", "))}</td>
          <td class="num">${g.gr ? esc(g.gr[0] === g.gr[1] ? g.gr[0] : g.gr[0] + "–" + g.gr[1]) : ""}</td>
        </tr>`).join("");
      box.innerHTML = `<div class="tablewrap"><table class="grid">
        <thead>${sortHead([["alpha", "Фамилия"], ["count", "Упоминаний"], ["", "Написание в источнике"], ["", "Места"], ["", "Годы рождения"]], f)}</thead>
        <tbody>${rows}</tbody></table></div>
        ${list.length > f.limit ? `<div class="more"><button data-more>Показать ещё (${list.length - f.limit})</button></div>` : ""}`;
      bindSort(box, f, draw);
      $$("tr[data-name]", box).forEach((tr) => tr.addEventListener("click", () => {
        Object.assign(S.pf, PF_RESET, { year: f.year, fam: tr.dataset.name, sort: "order" });
        S.scroll.persons = 0;
        location.hash = "#/persons";
      }));
      const more = $("[data-more]", box);
      if (more) more.addEventListener("click", () => { f.limit += 1000; draw(); });
    }
    draw();
  }

  /* ================= Места ================= */

  // Упоминание места хранит страницу, номер приказа и строку «звание имя отчество фамилия»,
  // собранную из исходной записи персоны, — по ним персона находится точно, даже когда место
  // слито из разных написаний или станица восстановлена.
  function whoKey(raw) {
    return [raw.звание, raw.имя, raw.отчество, raw.фамилия].filter(Boolean).join(" ");
  }

  function personsAt(place, year) {
    const D = Y();
    if (!D._byPageWho) {
      D._byPageWho = new Map();
      for (const p of D.persons) {
        const k = p.page + "|" + whoKey(p.raw);
        if (!D._byPageWho.has(k)) D._byPageWho.set(k, []);
        D._byPageWho.get(k).push(p);
      }
    }
    const found = new Set();
    for (const m of place.mentions) {
      if (!m.кто || !inYear(m, year)) continue;
      for (const p of D._byPageWho.get(m.page + "|" + m.кто) || []) found.add(p);
    }
    return [...found];
  }

  // Колонка звёзд ★ — только когда есть личный фокус поиска (локальная сборка).
  function placeCols() {
    const cols = [["name", "Наименование"], ["type", "Тип"], ["sta", "Станица"],
      ["otdel", "Отдел"], ["count", "Упоминаний"], ["", "Как упомянуто"], ["", "Написание в источнике"]];
    return hasFocus() ? [["", ""], ...cols] : cols;
  }

  function viewPlaces(app) {
    const f = S.plf;
    const types = [...new Set(Y().places.map((p) => p.тип))].sort((a, b) => a.localeCompare(b, "ru"));
    const conflicts = () => Y().conflicts.filter((c) => inYear(c, f.year));
    app.innerHTML = `
      <div class="panel"><div class="filters">
        ${yearSelect(f.year)}
        <label>Наименование или станица <input type="search" data-q placeholder="начало или часть названия"></label>
        <label>Тип <select data-type><option value="">любой</option>${types.map((t) => `<option>${esc(t)}</option>`).join("")}</select></label>
        <label>Отдел <select data-otdel><option value="">любой</option><option value="1">1-й</option><option value="2">2-й</option><option value="3">3-й</option></select></label>
        ${hasFocus() ? `<label class="check"><input type="checkbox" data-focus> только фокус поиска</label>` : ""}
      </div></div>
      <div class="toolbar"><span class="count" data-count></span><span class="grow"></span>
        <span class="hint">Место — наименование + станица + отдел: одинаковое название в разных станицах — разные места.</span></div>
      <div data-results></div>
      <div data-conflicts></div>`;
    const q = $("[data-q]", app), ty = $("[data-type]", app), ot = $("[data-otdel]", app), fc = $("[data-focus]", app);
    q.value = f.q; ty.value = f.type; ot.value = f.otdel;
    bindYear(app, f, draw);
    q.addEventListener("input", debounce(() => { f.q = q.value; draw(); }, 150));
    ty.addEventListener("change", () => { f.type = ty.value; draw(); });
    ot.addEventListener("change", () => { f.otdel = ot.value; draw(); });
    if (fc) { fc.checked = f.focus; fc.addEventListener("change", () => { f.focus = fc.checked; draw(); }); }

    const ru = (a, b) => (a || "").localeCompare(b || "", "ru");
    const byName = (a, b) => ru(a.p.наименование, b.p.наименование) || ru(a.p.станица, b.p.станица);

    function draw() {
      const qq = placeFold(f.q.trim());
      const list = [];
      for (const p of Y().places) {
        if (qq && !placeFold(p.наименование).includes(qq) && !placeFold(p.станица).includes(qq)) continue;
        if ((f.type && p.тип !== f.type) || (f.otdel && p.отдел !== f.otdel) || (f.focus && !p.focus)) continue;
        const ms = f.year ? p.mentions.filter((m) => m.year === f.year) : p.mentions;
        if (ms.length) list.push({ p, ms });
      }
      const cmp = {
        name: byName,
        type: (a, b) => ru(a.p.тип, b.p.тип),
        sta: (a, b) => ru(a.p.станица, b.p.станица),
        otdel: (a, b) => ru(a.p.отдел, b.p.отдел),
        count: (a, b) => b.ms.length - a.ms.length,
      }[f.sort] || byName;
      // Пустая станица и пустой отдел — в конец при любом направлении.
      const blank = (x) => (f.sort === "sta" ? !x.p.станица : f.sort === "otdel" ? !x.p.отдел : false);
      list.sort((a, b) => (blank(a) - blank(b)) || (cmp(a, b) * f.dir) || byName(a, b));
      $("[data-count]", app).textContent = `Мест: ${list.length}, упоминаний: ${list.reduce((s, x) => s + x.ms.length, 0)}`;
      const box = $("[data-results]", app);
      if (!list.length) box.innerHTML = `<p class="empty">Ничего не найдено.</p>`;
      else {
        const rows = list.slice(0, f.limit).map(({ p, ms }) => {
          const kinds = {};
          ms.forEach((m) => { kinds[m.вид] = (kinds[m.вид] || 0) + 1; });
          return `<tr data-href="#/place/${p.idx}${f.year ? "?y=" + f.year : ""}">
            ${hasFocus() ? `<td>${p.focus ? '<span class="star" title="фокус поиска">★</span>' : ""}</td>` : ""}
            <td><span class="name">${esc(p.наименование)}</span></td>
            <td>${esc(p.тип)}</td>
            <td>${esc(p.станица)}</td>
            <td class="num">${esc(p.отдел ? p.отдел + "-й" : "")}</td>
            <td class="num">${ms.length}</td>
            <td class="muted small">${esc(Object.entries(kinds).map(([k, v]) => `${k} ${v}`).join(", "))}</td>
            <td class="orig">${esc(p.варианты.join(", "))}</td>
          </tr>`;
        }).join("");
        box.innerHTML = `<div class="tablewrap"><table class="grid">
          <thead>${sortHead(placeCols(), f)}</thead>
          <tbody>${rows}</tbody></table></div>
          ${list.length > f.limit ? `<div class="more"><button data-more>Показать ещё</button></div>` : ""}`;
        bindRows(box);
        bindSort(box, f, draw);
        const more = $("[data-more]", box);
        if (more) more.addEventListener("click", () => { f.limit += 1000; draw(); });
      }
      const cs = conflicts();
      $("[data-conflicts]", app).innerHTML = cs.length ? `<h2>Что проверить</h2>
        <p class="hint">Посёлки без станицы с несколькими кандидатами не слиты. Отдел станицы взят по большинству записей;
          записи с другим отделом слиты и помечены в карточке места — это отдел перечисления или службы, попавший в поле, либо ошибка разбора.</p>
        <ul>${cs.map((c) => `<li>${multiYear() ? esc(c.year) + ": " : ""}${esc(c.text)}</li>`).join("")}</ul>` : "";
    }
    draw();
  }

  function viewPlace(app, idx, params) {
    const p = Y().places[+idx];
    if (!p) { app.innerHTML = `<p class="empty">Место не найдено.</p>`; return; }
    const year = params && params.y && Y().years.includes(params.y) ? params.y : "";
    const ms = year ? p.mentions.filter((m) => m.year === year) : p.mentions;
    const ppl = personsAt(p, year);
    const fam = new Map();
    ppl.forEach((x) => { if (x.фамилия) { const k = masc(fold(x.фамилия)); const e = fam.get(k) || { name: x.фамилия, n: 0 }; e.n++; fam.set(k, e); } });
    const famList = [...fam.values()].sort((a, b) => a.name.localeCompare(b.name, "ru"));
    const years = [...new Set(p.mentions.map((m) => m.year))].sort();
    const rows = ms.map((m) => {
      const o = orderForMention(m);
      const pg = Y().pageById.get(m.page);
      const href = o ? orderHref(o.key) : pageHref(m.page);
      const marks = [m.отдел_в_записи ? `в записи ${m.отдел_в_записи}-й отдел` : "",
        m.станица_восстановлена ? "станица восстановлена" : ""].filter(Boolean);
      return `<tr data-href="${esc(href)}">
        <td>${esc(m.вид)}</td>
        <td>${m.кто ? `<span class="name">${esc(m.кто)}</span>` : ""}${m.роль && m.роль !== "персона" ? ` <span class="muted small">${esc(m.роль)}</span>` : ""}</td>
        <td class="ev">${esc(m.событие || "")}${marks.length ? `<div>${marks.map((x) => `<span class="pill conf-medium">${esc(x)}</span>`).join(" ")}</div>` : ""}</td>
        <td class="nowrap">${o ? kindPill(o.тип) + "<div>" + esc(orderTitle(o)) + yearTag(o) + "</div>" : esc(m.номер || "")}</td>
        <td class="num">${esc(pageLabel(pg))}</td>
      </tr>`;
    }).join("");
    app.innerHTML = `
      <div class="crumbs"><a href="#/places">← места</a></div>
      <h1>${hasFocus() && p.focus ? '<span class="star">★</span> ' : ""}${esc(p.наименование)}</h1>
      <dl class="meta">
        <dt>Тип</dt><dd>${esc(p.тип)}</dd>
        ${p.станица ? `<dt>Станица</dt><dd>${esc(p.станица)}</dd>` : ""}
        ${p.отдел ? `<dt>Отдел</dt><dd>${esc(p.отдел)}-й</dd>` : ""}
        ${p.варианты.length ? `<dt>Написание в источнике</dt><dd class="orig">${esc(p.варианты.join(", "))}</dd>` : ""}
        <dt>Годы</dt><dd>${years.map((y) => y === year ? `<b>${esc(y)}</b>` : `<a href="#/place/${p.idx}?y=${esc(y)}">${esc(y)}</a>`).join(", ")}${year ? ` · <a href="#/place/${p.idx}">все</a>` : ""}</dd>
        <dt>Упоминаний</dt><dd>${ms.length} · персон: ${ppl.length}</dd>
      </dl>
      ${famList.length ? `<h2>Фамилии в пункте</h2><div class="chips">${famList.map((x) =>
        `<button class="chip" data-fam="${esc(x.name)}">${esc(x.name)} <span class="count">${x.n}</span></button>`).join("")}</div>` : ""}
      <h2>Упоминания</h2>
      <div class="tablewrap"><table class="grid">
        <thead><tr><th class="nosort">Как</th><th class="nosort">Кто</th><th class="nosort">Событие</th><th class="nosort">Приказ</th><th class="nosort">Стр.</th></tr></thead>
        <tbody>${rows}</tbody></table></div>`;
    bindRows(app);
    $$("[data-fam]", app).forEach((b) => b.addEventListener("click", () => {
      Object.assign(S.pf, PF_RESET, { year, fam: b.dataset.fam });
      S.scroll.persons = 0;
      location.hash = "#/persons";
    }));
    window.scrollTo(0, 0);
  }

  /* ================= Фокус ================= */

  function placeHit(p, pair) {
    const sta = placeStem(pair.станица), pos = pair.посёлок ? placeStem(pair.посёлок) : null;
    const trios = [p, p.откуда, p.куда].filter(Boolean);
    // Пара без посёлка — сама станица; по основе названия ловится и одноимённый посёлок
    // (в 1906 г. есть только посёлок Еманжелинский Еткульской станицы). Место в выдаче
    // показано как записано, подчинённость не подменяется.
    return trios.some((t) => pos
      ? placeStem(t.посёлок) === pos
      : placeStem(t.станица) === sta || placeStem(t.посёлок) === sta);
  }

  function hitItem(p, match) {
    const o = Y().orderByKey.get(p.order) || {};
    return `<li><a href="${esc(orderHref(p.order, p.i))}"><b>${esc(fio(p))}</b></a>
      <span class="pill ${match === "exact" ? "tag-exact" : "tag-similar"}">${match === "exact" ? "точно" : "похоже"}</span>
      ${origName(p) ? ` <span class="orig">${esc(origName(p))}</span>` : ""}
      <span class="muted"> · ${esc(ageTxt(p))} ${p.звание ? "· " + esc(p.звание) : ""}</span>
      <div class="small">${personPlace(p)}</div>
      <div class="muted small">${esc(p.событие || "")} — ${kindPill(o.тип)} ${esc(orderTitle(o))}${o.дата ? ", " + esc(fmtDate(o.дата)) : ""}${o.дата ? "" : ", " + esc(p.year)}, ${esc(pageLabel(p._page))}</div></li>`;
  }

  function viewFocus(app) {
    const f = S.ff;
    const cfg = OKV.focus;
    app.innerHTML = `
      <h1>Фокус поиска</h1>
      <p class="muted">Совпадения собраны автоматически и включают похожие написания — перед выводом сверять по скану.
        Место сопоставляется по основе названия, подчинённость в выдаче — как записана в приказе.</p>
      <div class="panel"><div class="filters">${yearSelect(f.year)}</div></div>
      <div data-body></div>`;
    bindYear(app, f, draw);

    function draw() {
      const persons = Y().persons.filter((p) => inYear(p, f.year));
      const pairs = cfg.личный_интерес.map((pair) => {
        const hits = [];
        for (const p of persons) {
          if (!placeHit(p, pair)) continue;
          let m = null;
          for (const s of pair.фамилии) { const r = surnameMatch(s, p.фамилия, true); if (r === "exact") { m = r; break; } if (r) m = r; }
          if (m) hits.push({ p, m });
        }
        hits.sort((a, b) => (a.m === b.m ? 0 : a.m === "exact" ? -1 : 1));
        const where = (pair.посёлок ? `пос. ${pair.посёлок}, ` : "") + `ст. ${pair.станица}`;
        return `<div class="panel"><h3>${esc(where)} — <span class="muted">${esc(pair.фамилии.join(", "))}</span></h3>
          ${hits.length ? `<ul class="hitlist">${hits.map((h) => hitItem(h.p, h.m)).join("")}</ul>` : `<p class="muted small">Совпадений нет.</p>`}</div>`;
      }).join("");

      const surnames = cfg.фамилии.map((s) => {
        const hits = persons.map((p) => ({ p, m: surnameMatch(s, p.фамилия, true) })).filter((x) => x.m)
          .sort((a, b) => (a.m === b.m ? 0 : a.m === "exact" ? -1 : 1));
        return `<div class="panel"><h3>${esc(s)} <span class="count">${hits.length}</span></h3>
          ${hits.length ? `<ul class="hitlist">${hits.map((h) => hitItem(h.p, h.m)).join("")}</ul>` : `<p class="muted small">Не встречается.</p>`}</div>`;
      }).join("");

      const fplaces = Y().places.filter((p) => p.focus)
        .map((p) => ({ p, n: p.mentions.filter((m) => inYear(m, f.year)).length })).filter((x) => x.n);

      $("[data-body]", app).innerHTML = `
        <h2>Личный интерес: фамилия + место</h2>
        <div class="cards">${pairs}</div>
        <h2>Фамилии фокуса</h2>
        <div class="cards">${surnames}</div>
        <h2>Места фокуса</h2>
        ${fplaces.length ? `<div class="tablewrap"><table class="grid"><thead><tr><th class="nosort">Место</th><th class="nosort">Упоминаний</th></tr></thead>
          <tbody>${fplaces.map(({ p, n }) => `<tr data-href="#/place/${p.idx}${f.year ? "?y=" + f.year : ""}"><td><span class="star">★</span> ${esc(p.label)}</td><td class="num">${n}</td></tr>`).join("")}</tbody></table></div>`
          : `<p class="muted">Мест фокуса нет.</p>`}`;
      bindRows($("[data-body]", app));
    }
    draw();
  }

  /* ================= Тексты ================= */

  let textIdx = null;
  function textIndex() {
    if (!textIdx) {
      textIdx = [];
      for (const o of Y().ordersSorted) for (const fr of o.fragments) {
        if (fr.текст) textIdx.push({ o, fr, fm: foldMap(fr.текст) });
      }
    }
    return textIdx;
  }

  function viewTexts(app) {
    const f = S.tf;
    app.innerHTML = `
      <div class="panel"><div class="filters">
        ${yearSelect(f.year)}
        <label class="wide">Поиск по текстам приказов <input type="search" data-q placeholder="например: дополнительный надел Еманжелинской"></label>
      </div>
      <p class="hint">Все слова сразу, каждое — по началу слова: «казач» найдёт и «казачьяго». Буквы ъ, ѣ, і, ѳ учтены.</p></div>
      <div class="toolbar"><span class="count" data-count></span></div>
      <div data-results></div>`;
    const q = $("[data-q]", app);
    q.value = f.q;
    bindYear(app, f, draw);
    q.addEventListener("input", debounce(() => { f.q = q.value; draw(); }, 250));
    q.focus();

    function draw() {
      const words = fold(f.q).split(/[^0-9a-zа-я]+/).filter((w) => w.length >= 2);
      const box = $("[data-results]", app);
      if (!words.length) { box.innerHTML = ""; $("[data-count]", app).textContent = ""; return; }
      const res = [];
      const byOrder = new Map();
      for (const t of textIndex()) {
        if (!inYear(t.o, f.year)) continue;
        const ranges = [];
        let ok = true;
        for (const w of words) {
          const re = new RegExp("(^|[^0-9a-zа-я])" + w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g");
          let m, found = false;
          while ((m = re.exec(t.fm.text))) {
            const s = m.index + m[1].length;
            ranges.push([s, s + w.length]); found = true;
            if (ranges.length > 60) break;
          }
          if (!found) { ok = false; break; }
        }
        if (!ok) continue;
        let e = byOrder.get(t.o.key);
        if (!e) { e = { o: t.o, frs: [] }; byOrder.set(t.o.key, e); res.push(e); }
        e.frs.push({ t, ranges });
      }
      $("[data-count]", app).textContent = `Приказов: ${res.length}`;
      box.innerHTML = res.length ? `<ul class="hitlist panel">${res.slice(0, 150).map(({ o, frs }) => `
        <li><a href="${esc(orderHref(o.key))}"><b>Приказ ${esc(orderTitle(o))}</b></a>${yearTag(o)} ${kindPill(o.тип)}
          <span class="muted">${esc(dateTxt(o))}</span> <span class="muted small">${esc(o.подтип || "")}</span>
          ${frs.slice(0, 3).map(({ t, ranges }) => snippet(t, ranges)).join("")}</li>`).join("")}</ul>
        ${res.length > 150 ? `<p class="muted">Показаны первые 150 — уточните запрос.</p>` : ""}`
        : `<p class="empty">Ничего не найдено.</p>`;
    }

    function snippet(t, ranges) {
      ranges.sort((a, b) => a[0] - b[0]);
      const src = t.fr.текст, map = t.fm.map;
      const o0 = map[ranges[0][0]];
      const from = Math.max(0, o0 - 120), to = Math.min(src.length, o0 + 220);
      let html = "", cur = from;
      for (const [fs, fe] of ranges) {
        const s = map[fs], e = map[fe - 1] + 1;
        if (s < cur || e > to) continue;
        html += esc(src.slice(cur, s)) + "<mark>" + esc(src.slice(s, e)) + "</mark>";
        cur = e;
      }
      html += esc(src.slice(cur, to));
      const pg = Y().pageById.get(t.fr.page);
      return `<div class="snip">${from > 0 ? "…" : ""}${html}${to < src.length ? "…" : ""}
        <span class="muted small"> — ${esc(pageLabel(pg))}</span></div>`;
    }
    draw();
  }

  /* ================= Том ================= */

  function viewVolume(app) {
    const f = S.vf;
    app.innerHTML = `
      <div class="panel"><div class="filters">
        ${yearSelect(f.year)}
        <label>Вид <select data-kind><option value="">все разобранные</option>
          ${Object.entries(KINDS).map(([k, v]) => `<option value="${k}">${v}</option>`).join("")}</select></label>
        <label class="check"><input type="checkbox" data-wp> только с персонами</label>
      </div></div>
      <div class="toolbar"><span class="count" data-count></span></div>
      <div class="volume" data-grid></div>`;
    const ks = $("[data-kind]", app), wp = $("[data-wp]", app);
    ks.value = f.kind; wp.checked = f.withPersons;
    bindYear(app, f, draw);
    ks.addEventListener("change", () => { f.kind = ks.value; draw(); });
    wp.addEventListener("change", () => { f.withPersons = wp.checked; draw(); });

    const perPage = new Map();
    Y().persons.forEach((p) => perPage.set(p.page, (perPage.get(p.page) || 0) + 1));

    function draw() {
      const list = Y().pages.filter((p) => inYear(p, f.year) && (!f.kind || p.kind === f.kind) && (!f.withPersons || perPage.get(p.id)));
      $("[data-count]", app).textContent = `Страниц: ${list.length}`;
      let group = null, html = "";
      for (const p of list) {
        const g = `${p.year}|${p.series}`;
        if (g !== group) { group = g; html += `<div class="series-h">${esc(p.year)} · серия ${esc(p.series)}</div>`; }
        const L = (p.kind || "").charAt(0);
        const th = p.thumb ? thumbSrc(p.id) : null;
        html += `<a class="thumb" href="${pageHref(p.id)}" title="${esc(p.note || "")}">
          ${th ? `<img loading="lazy" src="${esc(th)}" alt="">` : ""}
          <span class="row"><b>${esc(pageLabel(p))}</b><span class="kind kind-${esc(L)}">${esc(L)}</span></span>
          <span class="row muted"><span>${esc(p.rid)}</span><span>${perPage.get(p.id) || ""}</span></span></a>`;
      }
      $("[data-grid]", app).innerHTML = html || `<p class="empty">Страниц нет.</p>`;
    }
    draw();
  }

  /* ================= маршруты ================= */

  let currentView = null;

  /* Разделы сайта. В шапке — «Главная» и по кнопке на раздел; внутри подраздела под ними
     строка подразделов этого раздела. Маршруты приказов остались прежними (#/persons,
     #/order/…), чтобы не сломать ссылки из заметок; база жителей — под #/res/…. */
  const OKV_VIEWS = new Set(["persons", "order", "page", "surnames", "places", "place",
    "focus", "texts", "volume"]);
  const OKV_TABS = [
    ["persons", "Персоны", "Поиск человека по фамилии, имени, отчеству, месту, отделу, виду приказа и году рождения."],
    ["surnames", "Фамилии", "Указатель фамилий: сколько упоминаний, как написано в источнике, где встречается."],
    ["places", "Места", "Станицы, посёлки, выселки и города: все упоминания и фамилии каждого пункта."],
    ["focus", "Фокус", "Станицы, посёлки и фамилии, которые исследуются особо."],
    ["texts", "Тексты", "Поиск по полным текстам приказов в старой орфографии."],
    ["volume", "Том", "Все разобранные страницы по порядку, с миниатюрами сканов."]];
  const SECTION_TITLES = { home: "", okv: "Приказы ОКВ", res: "Жители Еткульской" };

  // Подразделы раздела: [href, ключ вкладки, название, пояснение].
  function sectionTabs(sec) {
    if (sec === "okv" && !hasOkv()) return [];
    if (sec === "res" && !hasRes()) return [];
    if (sec === "okv") return OKV_TABS.filter(([k]) => k !== "focus" || hasFocus()).map(([k, t, d]) => [`#/${k}`, k, t, d]);
    if (sec === "res") return OKV.res.tabs().map(([k, t, d]) => [`#/res/${k}`, k, t, d]);
    return [];
  }

  /* Кнопка раздела в шапке открывает выпадающий список подразделов; своей страницы у раздела нет. */
  function buildMenus() {
    $$("#sections .sec").forEach((box) => {
      const tabs = sectionTabs(box.dataset.sec);
      if (!tabs.length) { box.hidden = true; return; }
      const menu = $(".menu", box), btn = $(".sec-btn", box);
      menu.innerHTML = tabs.map(([href, k, t, d]) =>
        `<a href="${href}" data-tab="${k}"><b>${esc(t)}</b>${d ? `<span>${esc(d)}</span>` : ""}</a>`).join("");
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const open = menu.hidden;
        closeMenus();
        menu.hidden = !open;
        btn.setAttribute("aria-expanded", String(open));
      });
      menu.addEventListener("click", () => closeMenus());
    });
    document.addEventListener("click", (e) => { if (!e.target.closest("#sections .sec")) closeMenus(); });
    document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeMenus(); });
  }

  function closeMenus() {
    $$("#sections .menu").forEach((m) => { m.hidden = true; });
    $$("#sections .sec-btn").forEach((b) => b.setAttribute("aria-expanded", "false"));
  }

  function drawNav(sec, tab) {
    closeMenus();
    $$("#sections [data-sec]").forEach((el) => el.classList.toggle("on", el.dataset.sec === sec));
    $$("#sections .menu a").forEach((a) => a.classList.toggle("on",
      a.closest(".sec").dataset.sec === sec && a.dataset.tab === tab));
    const sub = $("#subnav");
    const tabs = sectionTabs(sec);
    if (!tabs.length) { sub.hidden = true; sub.innerHTML = ""; }
    else {
      sub.hidden = false;
      sub.innerHTML = `<span class="sub-title">${esc(SECTION_TITLES[sec])}</span>` +
        tabs.map(([href, k, t]) => `<a href="${href}" data-tab="${k}" class="${k === tab ? "on" : ""}">${esc(t)}</a>`).join("");
    }
    // Высота шапки меняется со строкой подразделов — от неё считаются липкий скан и его высота.
    document.documentElement.style.setProperty("--top-h", $(".top").offsetHeight + "px");
    const on = $("#subnav a.on");
    const parts = [SECTION_TITLES[sec], on ? on.textContent : ""].filter(Boolean);
    document.title = parts.length ? parts.join(" — ") : "Указатели по генеалогии и локальной истории";
  }

  function route() {
    const app = $("#app");
    if (currentView) S.scroll[currentView] = window.scrollY;
    const raw = location.hash.replace(/^#\/?/, "");
    const [path, query] = raw.split("?");
    const params = Object.fromEntries(new URLSearchParams(query || ""));
    const [view, ...rest] = path.split("/");
    const arg = rest.length ? decodeURIComponent(rest.join("/")) : null;

    if (view === "res") {
      if (!hasRes()) { location.hash = "#/home"; return; }
      currentView = rest.length <= 1 ? path : null;
      const r = OKV.res.route(app, rest.map(decodeURIComponent), params);
      if (r.home) { location.replace("#/home"); return; }
      drawNav("res", r.tab);
      if (currentView && rest.length) window.scrollTo(0, S.scroll[currentView] || 0);
      return;
    }

    // Без личного фокуса (веб-сборка) вкладки «Фокус» нет — маршрут уводит на главную.
    let v = (view || "home") === "focus" && !hasFocus() ? "home" : (view || "home");
    if (OKV_VIEWS.has(v) && !hasOkv()) v = "home";
    const year = params.y && Y().years.includes(params.y) ? params.y : null;
    // Выдачу можно открыть ссылкой из заметки: #/persons?fam=Захаров&place=Еткульская&y=1906,
    // #/surnames?q=Захар, #/places?q=Еманжелин, #/texts?q=надел
    const PF_URL = ["fam", "name", "otch", "place", "otdel", "kind", "role", "grFrom", "grTo"];
    if (v === "persons" && (year || PF_URL.some((k) => params[k] != null))) {
      Object.assign(S.pf, PF_RESET, { year: year || "" });
      PF_URL.forEach((k) => { if (params[k] != null) S.pf[k] = params[k]; });
      S.pf.similar = params.similar === "1";
      S.scroll.persons = 0;
    }
    if (v === "surnames" && params.q != null) Object.assign(S.sf, { q: params.q, year: year || "" });
    if (v === "places" && params.q != null) Object.assign(S.plf, { q: params.q, year: year || "" });
    if (v === "texts" && params.q != null) Object.assign(S.tf, { q: params.q, year: year || "" });
    const tab = { order: "persons", page: "volume", place: "places" }[v] || v;
    currentView = arg == null ? v : null;
    const views = {
      home: () => viewHome(app),
      persons: () => viewPersons(app), order: () => viewOrder(app, arg, params),
      page: () => viewPage(app, arg), surnames: () => viewSurnames(app),
      places: () => (arg != null ? viewPlace(app, arg, params) : viewPlaces(app)),
      place: () => viewPlace(app, arg, params), focus: () => viewFocus(app),
      texts: () => viewTexts(app), volume: () => viewVolume(app),
    };
    (views[v] || views.home)();
    if (currentView && v !== "home") window.scrollTo(0, S.scroll[currentView] || 0);
    drawNav(OKV_VIEWS.has(v) ? "okv" : "home", tab);
  }

  function loadScripts(files) {
    return new Promise((resolve) => {
      let left = files.length;
      if (!left) { resolve(); return; }
      const done = () => { if (--left <= 0) resolve(); };
      for (const name of files) {
        const s = document.createElement("script");
        s.src = name;
        s.onload = done;
        s.onerror = done;
        document.body.appendChild(s);
      }
    });
  }

  function boot() {
    const cfg = OKV.config || {};
    const years = cfg.years || [];
    const resFiles = OKV.res ? OKV.res.files(cfg) : [];
    if (!years.length && !resFiles.length) {
      $("#app").innerHTML = `<p class="empty">Нет данных. Соберите: <code>python prikaz_explorer.py --year 1906</code></p>`;
      return;
    }
    const dataLoaded = loadScripts([...years.map((y) => `data_${y}.js`), ...resFiles]);
    // Список сканов года (в вебе, config.js несёт images) — параллельно с данными,
    // не задерживая друг друга; первую отрисовку ждём обоих сразу — проще и надёжнее,
    // чем подставлять src отложенно, а запрос обычно укладывается в секунду.
    // Сканы базы жителей запрашиваются позже, при первом открытии скана (res.js).
    const imagesLoaded = Promise.all(years.map(loadYearImages));
    Promise.all([dataLoaded, imagesLoaded]).then(() => {
      const resOk = OKV.res && OKV.res.finalize();
      if (!S.loaded.length && !resOk) { $("#app").innerHTML = `<p class="empty">Файлы данных не загрузились.</p>`; return; }
      finalize();
      buildMenus();
      window.addEventListener("hashchange", route);
      window.addEventListener("resize", debounce(() =>
        document.documentElement.style.setProperty("--top-h", $(".top").offsetHeight + "px"), 150));
      route();
    });
  }

  // Общие помощники для модуля базы жителей (res.js) — чтобы вёрстка и поиск были одни.
  const helpers = { esc, $, $$, fold, masc, surnameMatch, debounce, sortHead, bindSort, bindRows,
    viewer, S };

  return { addYear, boot, finalize, config: null, focus: null, h: helpers,
    _S: S, _fold: fold, _surnameMatch: surnameMatch, _placeStem: placeStem };
})();
