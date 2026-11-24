// Twee PDF's voor de profielcheck (zie api/profielcheck-pdf.js):
//   1. "Profielcheck"      cijfers, scores, top 5 verbeterpunten, quick win, contentideeën
//   2. "Bio & highlights"  naam-veld, 3 bio's, highlight-iconen, tips-infographic
// In de PromoView-huisstijl (Inter, roze/magenta). Lettertype: Inter (SIL Open Font License, zie
// api/_fonts/OFL.txt), teruggebracht tot Latijnse tekens zodat de PDF klein blijft.
const fs = require("fs");
const path = require("path");
const { PDFDocument, rgb, pushGraphicsState, popGraphicsState, moveTo, appendBezierCurve, closePath, clip, endPath } = require("pdf-lib");
const fontkit = require("@pdf-lib/fontkit");

const hex = (h) => {
  const m = String(h || "").replace("#", "").match(/^([0-9a-f]{6})$/i);
  const n = m ? parseInt(m[1], 16) : 0xe84163;
  return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
};
const C = {
  ink: hex("#14121A"), dim: hex("#585161"), line: hex("#E5E0EA"), bg: hex("#FAF8FB"), white: rgb(1, 1, 1),
  pink: hex("#E84163"), hot: hex("#FF3B70"), magenta: hex("#C22BAF"), green: hex("#15A34A"), soft: hex("#FDEEF2"), greenSoft: hex("#EAF7EF"),
};
const W = 595.28, H = 841.89, M = 48;

const FONT_DIR = path.join(__dirname, "..", "_fonts");
let fontBytes = null;
function loadFonts() {
  if (!fontBytes) {
    fontBytes = {
      r: fs.readFileSync(path.join(FONT_DIR, "Inter-Regular.ttf")),
      s: fs.readFileSync(path.join(FONT_DIR, "Inter-SemiBold.ttf")),
      b: fs.readFileSync(path.join(FONT_DIR, "Inter-ExtraBold.ttf")),
    };
  }
  return fontBytes;
}

const txt = (v) => (v == null ? "" : String(v));
const nl = (d) => new Date(d || Date.now()).toLocaleDateString("nl-NL", { timeZone: "Europe/Amsterdam", day: "numeric", month: "long", year: "numeric" });

async function newDoc(title) {
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const fb = loadFonts();
  const f = {
    r: await doc.embedFont(fb.r, { subset: false }),
    s: await doc.embedFont(fb.s, { subset: false }),
    b: await doc.embedFont(fb.b, { subset: false }),
  };
  doc.setTitle(title);
  doc.setAuthor("PromoView");
  doc.setCreator("PromoView");
  doc.setProducer("PromoView");
  doc.setLanguage("nl-NL");
  const chars = new Set(f.r.getCharacterSet());
  return { doc, f, chars };
}

// Laat tekens weg die het lettertype niet kent (bijv. emoji), zodat er geen lege blokjes staan.
function clean(ctx, s) {
  return Array.from(txt(s).replace(/\r/g, "").replace(/[‍️]/g, ""))
    .filter((ch) => ch === "\n" || ctx.chars.has(ch.codePointAt(0)))
    .join("")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/[ \t]+([.,!?;:])/g, "$1");
}

function wrap(font, size, s, maxW) {
  const out = [];
  for (const para of txt(s).split("\n")) {
    const words = para.split(/\s+/).filter(Boolean);
    if (!words.length) { out.push(""); continue; }
    let line = "";
    for (const w of words) {
      const t = line ? line + " " + w : w;
      if (font.widthOfTextAtSize(t, size) <= maxW) line = t;
      else {
        if (line) out.push(line);
        // te lang woord: hard afbreken
        let rest = w;
        while (font.widthOfTextAtSize(rest, size) > maxW) {
          let i = rest.length;
          while (i > 1 && font.widthOfTextAtSize(rest.slice(0, i), size) > maxW) i--;
          out.push(rest.slice(0, i));
          rest = rest.slice(i);
        }
        line = rest;
      }
    }
    out.push(line);
  }
  return out;
}

// Eenvoudige paginaschrijver met een cursor (y loopt van boven naar beneden).
class Writer {
  constructor(ctx, meta) {
    this.ctx = ctx; this.meta = meta; this.page = null; this.y = 0; this.n = 0;
  }
  addPage(first) {
    this.page = this.ctx.doc.addPage([W, H]);
    this.n++;
    this.page.drawRectangle({ x: 0, y: 0, width: W, height: H, color: C.bg });
    if (first) this.header();
    else {
      this.page.drawRectangle({ x: 0, y: H - 6, width: W, height: 6, color: C.pink });
      this.y = H - 46;
    }
    this.footer();
  }
  header() {
    const p = this.page, { f } = this.ctx, m = this.meta;
    const hh = 168;
    p.drawRectangle({ x: 0, y: H - hh, width: W, height: hh, color: C.ink });
    // accentbalken in roze en magenta
    p.drawRectangle({ x: 0, y: H - hh, width: W * 0.62, height: 5, color: C.pink });
    p.drawRectangle({ x: W * 0.62, y: H - hh, width: W * 0.38, height: 5, color: C.magenta });
    p.drawText("Promo", { x: M, y: H - 52, size: 15, font: f.b, color: C.white });
    p.drawText("View", { x: M + f.b.widthOfTextAtSize("Promo", 15), y: H - 52, size: 15, font: f.b, color: C.hot });
    const right = clean(this.ctx, m.badge);
    const bw = f.s.widthOfTextAtSize(right, 9) + 20;
    p.drawRectangle({ x: W - M - bw, y: H - 57, width: bw, height: 20, color: m.test ? C.hot : C.magenta, borderRadius: 10 });
    p.drawText(right, { x: W - M - bw + 10, y: H - 50.5, size: 9, font: f.s, color: C.white });
    p.drawText(clean(this.ctx, m.title), { x: M, y: H - 106, size: 32, font: f.b, color: C.white });
    p.drawText("@" + clean(this.ctx, m.insta), { x: M, y: H - 134, size: 15, font: f.s, color: C.hot });
    const d = clean(this.ctx, m.date);
    p.drawText(d, { x: W - M - f.r.widthOfTextAtSize(d, 10), y: H - 132, size: 10, font: f.r, color: hex("#B8B2C2") });
    this.y = H - hh - 34;
  }
  footer() {
    const { f } = this.ctx, s = `PromoView · ${this.meta.title} voor @${this.meta.insta}`;
    this.page.drawLine({ start: { x: M, y: 40 }, end: { x: W - M, y: 40 }, thickness: 0.6, color: C.line });
    this.page.drawText(clean(this.ctx, s), { x: M, y: 26, size: 8, font: f.r, color: C.dim });
    const pn = String(this.n);
    this.page.drawText(pn, { x: W - M - f.r.widthOfTextAtSize(pn, 8), y: 26, size: 8, font: f.r, color: C.dim });
  }
  need(h) { if (this.y - h < 60) this.addPage(false); }
  text(s, { font = this.ctx.f.r, size = 10.5, color = C.ink, x = M, w = W - 2 * M, lh = 1.45, gap = 0 } = {}) {
    const lines = wrap(font, size, clean(this.ctx, s), w);
    for (const ln of lines) {
      this.need(size * lh);
      this.page.drawText(ln, { x, y: this.y - size, size, font, color });
      this.y -= size * lh;
    }
    this.y -= gap;
  }
  measure(s, font, size, w, lh = 1.45) { return wrap(font, size, clean(this.ctx, s), w).length * size * lh; }
  section(title, sub) {
    this.need(150); // kop nooit los onderaan een pagina
    this.y -= 14;
    this.page.drawRectangle({ x: M, y: this.y - 16, width: 4, height: 16, color: C.pink });
    this.page.drawText(clean(this.ctx, title), { x: M + 12, y: this.y - 14, size: 15, font: this.ctx.f.b, color: C.ink });
    this.y -= 24;
    if (sub) this.text(sub, { size: 9.5, color: C.dim, gap: 2 });
    this.y -= 6;
  }
  // Kaart met tekst; hoogte vooraf berekend zodat de kaart niet over een pagina breekt.
  card(h, { fill = C.white, border = C.line, left = null } = {}) {
    this.need(h + 10);
    const top = this.y;
    this.page.drawRectangle({ x: M, y: top - h, width: W - 2 * M, height: h, color: fill, borderColor: border, borderWidth: 0.8, borderRadius: 10 });
    if (left) this.page.drawRectangle({ x: M, y: top - h, width: 4, height: h, color: left });
    return top;
  }
}

function circleClip(page, cx, cy, r) {
  const k = 0.5523 * r;
  page.pushOperators(
    pushGraphicsState(),
    moveTo(cx + r, cy),
    appendBezierCurve(cx + r, cy + k, cx + k, cy + r, cx, cy + r),
    appendBezierCurve(cx - k, cy + r, cx - r, cy + k, cx - r, cy),
    appendBezierCurve(cx - r, cy - k, cx - k, cy - r, cx, cy - r),
    appendBezierCurve(cx + k, cy - r, cx + r, cy - k, cx + r, cy),
    closePath(), clip(), endPath(),
  );
}

async function embedImage(doc, b64) {
  if (!b64) return null;
  try {
    const buf = Buffer.from(String(b64).replace(/^data:[^,]+,/, ""), "base64");
    if (buf[0] === 0xff && buf[1] === 0xd8) return await doc.embedJpg(buf);
    if (buf[0] === 0x89 && buf[1] === 0x50) return await doc.embedPng(buf);
  } catch (_) {}
  return null;
}

const CIJFERS = [["volgers", "Volgers"], ["volgend", "Volgend"], ["posts", "Posts"], ["gem_likes", "Gem. likes"], ["gem_reacties", "Gem. reacties"], ["engagement", "Engagement"]];

async function profielcheckPdf(a, meta) {
  const ctx = await newDoc(`Profielcheck @${meta.insta}`);
  const w = new Writer(ctx, { ...meta, title: "Profielcheck" });
  const { f } = ctx;
  w.addPage(true);

  if (a.samenvatting) w.text(a.samenvatting, { size: 12, font: f.s, lh: 1.5, gap: 10 });

  // Cijfers
  const cij = a.cijfers || {};
  const items = CIJFERS.map(([k, l]) => [l, txt(cij[k]).trim()]).filter(([, v]) => v && v.toLowerCase() !== "null");
  if (items.length) {
    const cols = Math.min(items.length, 6), gap = 8, cw = (W - 2 * M - gap * (cols - 1)) / cols, ch = 58;
    w.need(ch + 10);
    items.slice(0, 6).forEach(([l, v], i) => {
      const x = M + i * (cw + gap);
      w.page.drawRectangle({ x, y: w.y - ch, width: cw, height: ch, color: C.white, borderColor: C.line, borderWidth: 0.8, borderRadius: 8 });
      let size = 17;
      const val = clean(ctx, v);
      while (size > 9 && f.b.widthOfTextAtSize(val, size) > cw - 14) size -= 1;
      w.page.drawText(val, { x: x + 9, y: w.y - 28, size, font: f.b, color: C.ink });
      w.page.drawText(l, { x: x + 9, y: w.y - 46, size: 8.5, font: f.r, color: C.dim });
    });
    w.y -= ch + 8;
    if (cij.toelichting) w.text(cij.toelichting, { size: 8.5, color: C.dim, gap: 4 });
  }

  // Scores
  const scores = Array.isArray(a.scores) ? a.scores : [];
  if (scores.length) {
    w.section("Scores", "Per onderdeel van het profiel, op een schaal van 1 tot 10.");
    for (const s of scores) {
      const uitleg = clean(ctx, s.uitleg), uw = W - 2 * M - 28;
      const h = 34 + w.measure(uitleg, f.r, 9.5, uw);
      const top = w.card(h);
      const sc = Number(s.score);
      const has = Number.isFinite(sc) && sc > 0;
      w.page.drawText(clean(ctx, s.onderdeel), { x: M + 14, y: top - 20, size: 11, font: f.s, color: C.ink });
      // balk
      const bx = W - M - 14 - 150, by = top - 19;
      w.page.drawRectangle({ x: bx, y: by, width: 110, height: 7, color: C.line, borderRadius: 3.5 });
      if (has) w.page.drawRectangle({ x: bx, y: by, width: Math.max(7, (110 * Math.min(sc, 10)) / 10), height: 7, color: sc >= 7 ? C.green : sc >= 5 ? C.magenta : C.pink, borderRadius: 3.5 });
      const lab = has ? `${sc}/10` : "n.v.t.";
      w.page.drawText(lab, { x: W - M - 14 - f.b.widthOfTextAtSize(lab, 11), y: top - 20, size: 11, font: f.b, color: has ? C.ink : C.dim });
      w.y = top - 30;
      w.text(uitleg, { size: 9.5, color: C.dim, x: M + 14, w: uw });
      w.y = top - h - 8;
    }
  }

  // Top 5
  const vp = Array.isArray(a.verbeterpunten) ? a.verbeterpunten : [];
  if (vp.length) {
    w.section("Top 5 verbeterpunten", "Op volgorde van impact: begin bovenaan.");
    vp.slice(0, 5).forEach((p, i) => {
      const tw = W - 2 * M - 58, titel = clean(ctx, p.titel), uitleg = clean(ctx, p.uitleg);
      const h = 22 + w.measure(titel, f.s, 11.5, tw, 1.35) + w.measure(uitleg, f.r, 9.5, tw);
      const top = w.card(h);
      w.page.drawCircle({ x: M + 24, y: top - 24, size: 12, color: C.pink });
      const num = String(i + 1);
      w.page.drawText(num, { x: M + 24 - f.b.widthOfTextAtSize(num, 12) / 2, y: top - 28.5, size: 12, font: f.b, color: C.white });
      w.y = top - 12;
      w.text(titel, { font: f.s, size: 11.5, x: M + 46, w: tw, lh: 1.35 });
      w.text(uitleg, { size: 9.5, color: C.dim, x: M + 46, w: tw });
      w.y = top - h - 8;
    });
  }

  // Quick win
  if (a.quick_win && (a.quick_win.titel || a.quick_win.uitleg)) {
    w.section("Quick win deze week");
    const tw = W - 2 * M - 32, titel = clean(ctx, a.quick_win.titel), uitleg = clean(ctx, a.quick_win.uitleg);
    const h = 26 + w.measure(titel, f.b, 12.5, tw, 1.35) + w.measure(uitleg, f.r, 10, tw);
    const top = w.card(h, { fill: C.greenSoft, border: hex("#BfE6CC"), left: C.green });
    w.y = top - 14;
    w.text(titel, { font: f.b, size: 12.5, x: M + 18, w: tw, lh: 1.35 });
    w.text(uitleg, { size: 10, x: M + 18, w: tw });
    w.y = top - h - 8;
  }

  // Contentideeën
  const ci = Array.isArray(a.contentideeen) ? a.contentideeen : [];
  if (ci.length) {
    w.section("5 contentideeën", "Afgestemd op jouw doelgroep. Neem ze mee in de contentplanning.");
    for (const c of ci.slice(0, 6)) {
      const tw = W - 2 * M - 28, titel = clean(ctx, c.titel), uitleg = clean(ctx, c.uitleg), type = clean(ctx, c.type || "Post");
      const h = 40 + w.measure(titel, f.s, 11, tw, 1.35) + w.measure(uitleg, f.r, 9.5, tw);
      const top = w.card(h);
      const tw2 = f.s.widthOfTextAtSize(type.toUpperCase(), 7.5) + 14;
      w.page.drawRectangle({ x: M + 14, y: top - 24, width: tw2, height: 14, color: C.soft, borderRadius: 7 });
      w.page.drawText(type.toUpperCase(), { x: M + 21, y: top - 20, size: 7.5, font: f.s, color: C.pink });
      w.y = top - 30;
      w.text(titel, { font: f.s, size: 11, x: M + 14, w: tw, lh: 1.35 });
      w.text(uitleg, { size: 9.5, color: C.dim, x: M + 14, w: tw });
      w.y = top - h - 8;
    }
  }
  return ctx.doc.save();
}

async function bioHighlightsPdf(a, highlights, infographic, meta) {
  const ctx = await newDoc(`Bio & highlights @${meta.insta}`);
  const w = new Writer(ctx, { ...meta, title: "Bio & highlights" });
  const { f, doc } = ctx;
  w.addPage(true);

  // Naam-veld
  if (a.naamveld && a.naamveld.voorstel) {
    w.section("Naam-veld", "De naam is doorzoekbaar op Instagram: zet er een zoekwoord in (max. 64 tekens).");
    const tw = W - 2 * M - 32, v = clean(ctx, a.naamveld.voorstel), why = clean(ctx, a.naamveld.waarom);
    const h = 30 + w.measure(v, f.b, 15, tw, 1.3) + (why ? w.measure(why, f.r, 9.5, tw) : 0);
    const top = w.card(h, { left: C.magenta });
    w.y = top - 14;
    w.text(v, { font: f.b, size: 15, x: M + 18, w: tw, lh: 1.3 });
    w.page.drawText(`${Array.from(v).length}/64 tekens`, { x: W - M - 14 - f.s.widthOfTextAtSize(`${Array.from(v).length}/64 tekens`, 8.5), y: top - 16, size: 8.5, font: f.s, color: C.dim });
    if (why) w.text(why, { size: 9.5, color: C.dim, x: M + 18, w: tw });
    w.y = top - h - 8;
  }

  // Bio's
  const bios = Array.isArray(a.bios) ? a.bios : [];
  if (bios.length) {
    w.section("Bio: 3 varianten", "Kies er één, of combineer. Instagram staat maximaal 150 tekens toe.");
    bios.slice(0, 3).forEach((b, i) => {
      const tw = W - 2 * M - 36, bio = clean(ctx, b.tekst), why = clean(ctx, b.waarom);
      const count = Array.from(txt(b.tekst)).length;
      const h = 46 + w.measure(bio, f.s, 11.5, tw, 1.45) + (why ? w.measure(why, f.r, 9.5, tw) + 4 : 0);
      const top = w.card(h);
      w.page.drawText(`VARIANT ${i + 1}`, { x: M + 18, y: top - 20, size: 8, font: f.b, color: C.pink });
      const cnt = `${count}/150 tekens`, ok = count <= 150;
      const cw = f.s.widthOfTextAtSize(cnt, 8) + 14;
      w.page.drawRectangle({ x: W - M - 14 - cw, y: top - 24, width: cw, height: 14, color: ok ? C.greenSoft : C.soft, borderRadius: 7 });
      w.page.drawText(cnt, { x: W - M - 7 - cw, y: top - 20, size: 8, font: f.s, color: ok ? C.green : C.pink });
      w.y = top - 32;
      w.text(bio, { font: f.s, size: 11.5, x: M + 18, w: tw });
      if (why) { w.y -= 4; w.text(why, { size: 9.5, color: C.dim, x: M + 18, w: tw }); }
      w.y = top - h - 8;
    });
  }

  // Highlights met iconen
  const hl = (Array.isArray(highlights) && highlights.length ? highlights : (a.highlights || [])).slice(0, 6);
  if (hl.length) {
    w.addPage(false);
    w.section("Highlights", "Covers in jouw stijl. Je krijgt ze van ons ook als losse afbeeldingen: sla ze op je telefoon op en kies ze als highlight-cover.");
    const cols = 3, gap = 14, cw = (W - 2 * M - gap * (cols - 1)) / cols, r = 46;
    for (let i = 0; i < hl.length; i += cols) {
      const row = hl.slice(i, i + cols);
      const rowH = Math.max(...row.map((h) => 2 * r + 46 + w.measure(clean(ctx, h.inhoud), f.r, 9, cw - 20, 1.4)));
      w.need(rowH + 10);
      for (let j = 0; j < row.length; j++) {
        const h = row[j], x = M + j * (cw + gap), top = w.y;
        w.page.drawRectangle({ x, y: top - rowH, width: cw, height: rowH, color: C.white, borderColor: C.line, borderWidth: 0.8, borderRadius: 10 });
        const cx = x + cw / 2, cy = top - 16 - r;
        const img = await embedImage(doc, h.img);
        w.page.drawCircle({ x: cx, y: cy, size: r + 3, borderColor: C.line, borderWidth: 1.2, color: C.white });
        if (img) {
          circleClip(w.page, cx, cy, r);
          w.page.drawImage(img, { x: cx - r, y: cy - r, width: 2 * r, height: 2 * r });
          w.page.pushOperators(popGraphicsState());
        } else {
          w.page.drawCircle({ x: cx, y: cy, size: r, color: C.soft });
        }
        const naam = clean(ctx, h.naam);
        w.page.drawText(naam, { x: cx - f.s.widthOfTextAtSize(naam, 11) / 2, y: cy - r - 20, size: 11, font: f.s, color: C.ink });
        const lines = wrap(f.r, 9, clean(ctx, h.inhoud), cw - 20);
        lines.forEach((ln, k) => w.page.drawText(ln, { x: cx - f.r.widthOfTextAtSize(ln, 9) / 2, y: cy - r - 36 - k * 12.6, size: 9, font: f.r, color: C.dim }));
      }
      w.y -= rowH + gap;
    }
  }

  // Tips-infographic: eigen pagina
  const info = await embedImage(doc, infographic);
  if (info) {
    w.addPage(false);
    w.section("Tips & tricks", a.tips_visual && a.tips_visual.titel ? a.tips_visual.titel : null);
    const maxW = W - 2 * M, maxH = w.y - 60;
    const s = Math.min(maxW / info.width, maxH / info.height);
    const iw = info.width * s, ih = info.height * s;
    w.page.drawImage(info, { x: (W - iw) / 2, y: w.y - ih, width: iw, height: ih });
    w.y -= ih + 10;
  }
  return ctx.doc.save();
}

async function maakRapporten({ analyse, highlights, infographic, insta, test }) {
  const meta = { insta, test: !!test, date: nl(), badge: test ? "TEST" : "Gratis bij je start" };
  const a = analyse || {};
  const [p1, p2] = await Promise.all([profielcheckPdf(a, meta), bioHighlightsPdf(a, highlights, infographic, meta)]);
  return {
    pdf1: Buffer.from(p1).toString("base64"),
    pdf1_naam: `Profielcheck-${insta}.pdf`,
    pdf2: Buffer.from(p2).toString("base64"),
    pdf2_naam: `Bio-en-highlights-${insta}.pdf`,
    iconen: iconBestanden(highlights),
  };
}

// De highlight-iconen als losse afbeeldingen, om te downloaden en als cover in te stellen.
function slug(s) {
  return txt(s).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 30) || "icoon";
}
function iconBestanden(highlights) {
  return (highlights || [])
    .map((h, i) => {
      const data = String((h && h.img) || "").replace(/^data:[^,]+,/, "");
      if (!data) return null;
      const png = data.startsWith("iVBOR");
      return { bestand: `Highlight-${i + 1}-${slug(h.naam)}.${png ? "png" : "jpg"}`, titel: `Highlight ${i + 1}: ${txt(h.naam)}`, data };
    })
    .filter(Boolean);
}

module.exports = { maakRapporten };
