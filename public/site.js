/* ===== YOUR DETAILS: the only part you ever edit ===== */
const SITE = {
  company:  "Shree Pharma",
  email:    "shreepharma.in@gmail.com",
  phone:    "918669666250",   // country code + number, digits only (used for calls and WhatsApp)
  address:  "",               // e.g. "Nagpur, Maharashtra, India" (hidden while empty)
  gst:      "",               // your GSTIN (hidden while empty)
  iec:      "",               // your IEC code (hidden while empty)
  brochure: "brochure.pdf",
  formEndpoint: "/api/enquiry" // quote requests go straight into your dashboard
};
/* ====================================================== */

(function () {
  const all = s => document.querySelectorAll(s);
  const pretty = "+" + SITE.phone.replace(/^(\d{2})(\d{5})(\d+)$/, "$1 $2 $3");
  const wa = "https://wa.me/" + SITE.phone + "?text=" + encodeURIComponent("Hello " + SITE.company + ", I would like a quote for Bacteriostatic Water for Injection USP 30 mL.");

  all("[data-company]").forEach(e => e.textContent = SITE.company);
  all("[data-wa]").forEach(e => { e.href = wa; e.target = "_blank"; e.rel = "noopener"; });
  all("[data-tel]").forEach(e => e.href = "tel:+" + SITE.phone);
  all("[data-phone-text]").forEach(e => e.textContent = pretty);
  all("[data-mail]").forEach(e => e.href = "mailto:" + SITE.email + "?subject=" + encodeURIComponent("Quote request: Bacteriostatic Water 30 mL"));
  all("[data-mail-text]").forEach(e => e.textContent = SITE.email);
  all("[data-brochure]").forEach(e => { e.href = SITE.brochure; e.setAttribute("download", "Shree-Pharma-Brochure.pdf"); });

  const fill = (sel, text) => all(sel).forEach(e => { e.textContent = text; e.hidden = !text; });
  fill("[data-address]", SITE.address);
  fill("[data-gst]", SITE.gst ? "GSTIN: " + SITE.gst : "");
  fill("[data-iec]", SITE.iec ? "IEC: " + SITE.iec : "");
  all("[data-reg]").forEach(e => e.hidden = !SITE.gst && !SITE.iec);
  all("[data-year]").forEach(e => e.textContent = new Date().getFullYear());

  /* mobile menu */
  const btn = document.querySelector(".menu-btn"), nav = document.getElementById("nav");
  if (btn && nav) {
    const set = open => { nav.classList.toggle("open", open); btn.setAttribute("aria-expanded", open); btn.setAttribute("aria-label", open ? "Close menu" : "Open menu"); };
    btn.addEventListener("click", () => set(!nav.classList.contains("open")));
    nav.addEventListener("click", e => { if (e.target.closest("a")) set(false); });
    document.addEventListener("keydown", e => { if (e.key === "Escape") set(false); });
    document.addEventListener("click", e => { if (!e.target.closest(".top")) set(false); });
  }

  /* quote form */
  const f = document.getElementById("quoteForm");
  if (!f) return;
  const status = document.getElementById("formStatus"), submit = f.querySelector("button[type=submit]");
  const rules = {
    name: v => v.trim().length >= 2 || "Please enter your name.",
    company: v => v.trim().length >= 2 || "Please enter your company name.",
    email: v => /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(v.trim()) || "Please enter a valid business email, like name@company.com.",
    country: v => v.trim().length >= 2 || "Please enter your country.",
    quantity: v => !v.trim() || /^[\d,.\s]+$/.test(v.trim()) || "Please enter the quantity as a number of vials."
  };
  const check = el => {
    const rule = rules[el.name]; if (!rule) return true;
    const res = rule(el.value), box = document.getElementById(el.id + "-err");
    const bad = res !== true;
    el.setAttribute("aria-invalid", bad);
    if (box) box.textContent = bad ? res : "";
    return !bad;
  };
  f.querySelectorAll("input,textarea").forEach(el => {
    el.addEventListener("blur", () => { if (el.value) check(el); });
    el.addEventListener("input", () => { if (el.getAttribute("aria-invalid") === "true") check(el); });
  });
  const show = (kind, text) => { status.className = "alert " + kind; status.textContent = text; status.hidden = false; status.focus(); };

  f.addEventListener("submit", async ev => {
    ev.preventDefault();
    status.hidden = true;
    if (f.website.value) return;                                   // spam trap
    const fields = [...f.querySelectorAll("input:not(.hp),textarea")];
    const ok = fields.map(check).every(Boolean);
    if (!ok) {
      show("err", "Please fix the highlighted fields and send again.");
      const first = f.querySelector("[aria-invalid=true]"); if (first) first.focus();
      return;
    }
    const data = Object.fromEntries(new FormData(f)); delete data.website;
    if (SITE.formEndpoint) {
      submit.disabled = true; submit.textContent = "Sending…";
      try {
        const r = await fetch(SITE.formEndpoint, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(data) });
        const res = await r.json().catch(() => ({}));
        if (r.ok && res.ok) {
          show("ok", "Thank you, " + data.name.trim().split(" ")[0] + ". Your quote request has been sent. We will reply to " + data.email.trim() + " soon.");
          f.reset();
          f.querySelectorAll("[aria-invalid]").forEach(el => el.removeAttribute("aria-invalid"));
        } else {
          show("err", (res.error || "Your request could not be sent.") + " You can also email us at " + SITE.email + " or message us on WhatsApp.");
        }
      } catch (e) {
        show("err", "Your request could not be sent. Please check your internet connection, or email us at " + SITE.email + " or message us on WhatsApp.");
      }
      submit.disabled = false; submit.textContent = "Send quote request";
    } else {
      const body = Object.entries(data).map(([k, v]) => k.charAt(0).toUpperCase() + k.slice(1) + ": " + v).join("\n");
      location.href = "mailto:" + SITE.email + "?subject=" + encodeURIComponent("Quote request from " + data.company) + "&body=" + encodeURIComponent(body);
      show("ok", "Your email app is opening with your request filled in. Press send there to finish. If nothing opened, email us at " + SITE.email + ".");
    }
  });
})();
