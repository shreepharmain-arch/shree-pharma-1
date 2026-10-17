/* ===== YOUR DETAILS: the only part you ever edit ===== */
const SITE = {
  company:  "Shree Pharma",
  email:    "shreepharma.in@gmail.com",
  phone:    "918669666250",   // country code + number, digits only (used for calls and WhatsApp)
  address:  "",               // e.g. "Nagpur, Maharashtra, India" (hidden while empty)
  gst:      "27ADHPM6491M1ZU", // your GSTIN (hidden while empty)
  iec:      "0305066081",     // your IEC code (hidden while empty)
  brochure: "/brochure.pdf",
  formEndpoint: "/api/enquiry" // quote requests go straight into your dashboard
};
/* ====================================================== */

(function () {
  "use strict";
  const all = s => document.querySelectorAll(s);
  const $ = id => document.getElementById(id);
  const pretty = "+" + SITE.phone.replace(/^(\d{2})(\d{5})(\d+)$/, "$1 $2 $3");
  const wa = "https://wa.me/" + SITE.phone + "?text=" + encodeURIComponent("Hello " + SITE.company + ", I would like a price for Bacteriostatic Water for Injection USP 30 mL.");

  all("[data-company]").forEach(e => e.textContent = SITE.company);
  all("[data-wa]").forEach(e => { e.href = wa; e.target = "_blank"; e.rel = "noopener"; });
  all("[data-tel]").forEach(e => e.href = "tel:+" + SITE.phone);
  all("[data-phone-text]").forEach(e => e.textContent = pretty);
  all("[data-mail]").forEach(e => e.href = "mailto:" + SITE.email + "?subject=" + encodeURIComponent("Price request: Bacteriostatic Water 30 mL"));
  all("[data-mail-text]").forEach(e => e.textContent = SITE.email);
  all("[data-brochure]").forEach(e => { e.href = SITE.brochure; e.setAttribute("download", "Shree-Pharma-Brochure.pdf"); });

  const fill = (sel, text) => all(sel).forEach(e => { e.textContent = text; e.hidden = !text; });
  fill("[data-address]", SITE.address);
  fill("[data-gst]", SITE.gst ? "GSTIN: " + SITE.gst : "");
  fill("[data-iec]", SITE.iec ? "IEC: " + SITE.iec : "");
  all("[data-year]").forEach(e => e.textContent = new Date().getFullYear());

  /* mobile menu */
  const btn = document.querySelector(".menu-btn"), nav = $("nav");
  let menuOpen = false;
  if (btn && nav) {
    const set = open => { menuOpen = open; nav.classList.toggle("open", open); btn.setAttribute("aria-expanded", open); btn.setAttribute("aria-label", open ? "Close menu" : "Open menu"); updateBar(); };
    btn.addEventListener("click", () => set(!nav.classList.contains("open")));
    nav.addEventListener("click", e => { if (e.target.closest("a")) set(false); });
    document.addEventListener("keydown", e => { if (e.key === "Escape" && menuOpen) { set(false); btn.focus(); } });
    document.addEventListener("click", e => { if (menuOpen && !e.target.closest(".top")) set(false); });
  }

  /* phone action bar: hidden while the top buttons, the quote form or the footer are on screen */
  const bar = $("mbar");
  const inView = new Set();
  function updateBar() { if (bar) bar.classList.toggle("away", menuOpen || inView.size > 0); }
  if (bar && "IntersectionObserver" in window) {
    const io = new IntersectionObserver(entries => {
      entries.forEach(en => { if (en.isIntersecting) inView.add(en.target); else inView.delete(en.target); });
      updateBar();
    }, { rootMargin: "0px 0px -15% 0px" });
    [document.querySelector(".hero .ctas"), $("quote"), document.querySelector("footer")].forEach(el => { if (el) io.observe(el); });
  }

  /* specifications: show the key rows first */
  const specs = $("specs"), specBtn = document.querySelector(".spec-toggle");
  if (specs && specBtn) {
    specs.classList.add("collapsed"); specBtn.hidden = false;
    specBtn.addEventListener("click", () => {
      const open = specs.classList.toggle("collapsed") === false;
      specBtn.setAttribute("aria-expanded", open);
      specBtn.textContent = open ? "Show fewer specifications" : "Show all specifications";
    });
  }

  /* photo viewer */
  const zoom = $("zoom"), zoomImg = $("zoomImg");
  if (zoom && typeof zoom.showModal === "function") {
    all("[data-zoom]").forEach(a => a.addEventListener("click", e => {
      e.preventDefault();
      const img = a.querySelector("img");
      zoomImg.src = a.getAttribute("href"); zoomImg.alt = img ? img.alt : "";
      zoom.showModal();
    }));
    zoom.querySelector(".zoom-close").addEventListener("click", () => zoom.close());
    zoom.addEventListener("click", e => { if (e.target === zoom) zoom.close(); });
  }

  /* quote form */
  const f = $("quoteForm");
  if (!f) return;
  const status = $("formStatus"), summary = $("formSummary"), submit = f.querySelector("button[type=submit]");
  const done = $("formDone"), doneText = $("doneText");
  const noteBtn = f.querySelector(".add-note"), noteBox = $("noteBox");
  if (noteBtn && noteBox) noteBtn.addEventListener("click", () => {
    noteBox.hidden = false; noteBtn.hidden = true; noteBtn.setAttribute("aria-expanded", "true"); $("message").focus();
  });

  const rules = {
    name: v => v.trim().length >= 2 || "Enter your name.",
    company: v => v.trim().length >= 2 || "Enter your company name.",
    email: v => /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(v.trim()) || "Enter a business email, like name@company.com.",
    country: v => v.trim().length >= 2 || "Enter the country to ship to."
  };
  const check = el => {
    const rule = rules[el.name]; if (!rule) return true;
    const res = rule(el.value), box = $(el.id + "-err");
    const bad = res !== true;
    el.setAttribute("aria-invalid", bad);
    if (box) box.textContent = bad ? res : "";
    return !bad;
  };
  f.querySelectorAll("input,textarea").forEach(el => {
    el.addEventListener("blur", () => { if (el.value) check(el); });
    el.addEventListener("input", () => { if (el.getAttribute("aria-invalid") === "true") check(el); });
  });
  const fail = text => { status.textContent = text; status.hidden = false; status.focus(); };
  const label = "Send request";

  f.addEventListener("submit", async ev => {
    ev.preventDefault();
    status.hidden = true; summary.hidden = true;
    if (f.website.value) return;                                   // spam trap
    const bad = Object.keys(rules).map(n => f.elements[n]).filter(el => !check(el));
    if (bad.length) {
      summary.textContent = bad.length === 1 ? "One field needs fixing: " + bad[0].labels[0].textContent.replace("Optional", "").trim() + "." : bad.length + " fields need fixing. They are marked below.";
      summary.hidden = false;
      bad[0].focus();
      return;
    }
    const data = Object.fromEntries(new FormData(f)); delete data.website;
    if (!SITE.formEndpoint) {
      const body = Object.entries(data).map(([k, v]) => k.charAt(0).toUpperCase() + k.slice(1) + ": " + v).join("\n");
      location.href = "mailto:" + SITE.email + "?subject=" + encodeURIComponent("Price request from " + data.company) + "&body=" + encodeURIComponent(body);
      return;
    }
    submit.disabled = true; submit.textContent = "Sending…";
    try {
      const r = await fetch(SITE.formEndpoint, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(data) });
      const res = await r.json().catch(() => ({}));
      if (r.ok && res.ok) {
        doneText.textContent = "Thank you, " + data.name.trim().split(" ")[0] + ". We'll email a written quote to " + data.email.trim() + ", usually within one business day.";
        f.hidden = true; done.hidden = false; done.focus();
        f.reset();
        f.querySelectorAll("[aria-invalid]").forEach(el => el.removeAttribute("aria-invalid"));
      } else {
        fail((res.error || "Your request was not sent.") + " You can also email " + SITE.email + " or message us on WhatsApp.");
      }
    } catch (e) {
      fail("Your request was not sent. Check your internet connection and try again, or email " + SITE.email + ".");
    }
    submit.disabled = false; submit.textContent = label;
  });

  const again = $("againBtn");
  if (again) again.addEventListener("click", () => {
    done.hidden = true; f.hidden = false;
    if (noteBox && noteBtn) { noteBox.hidden = true; noteBtn.hidden = false; noteBtn.setAttribute("aria-expanded", "false"); }
    $("name").focus();
  });
})();
