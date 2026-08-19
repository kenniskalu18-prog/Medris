(function () {
  "use strict";

  const supabase = window.mobihealthSupabase;
  const TOTAL_STEPS = 5;
  let currentStep = 1;
  let submitting = false;
  let settings = { application_status: "open", deadline: "2026-09-05T23:59:59+01:00" };

  const overlay = document.getElementById("modalOverlay");
  const form = document.getElementById("applicationForm");
  const modalBody = document.querySelector(".modal-body");
  const stepLabel = document.getElementById("modalStepLabel");
  const progressFill = document.getElementById("progressFill");
  const backBtn = document.getElementById("backBtn");
  const nextBtn = document.getElementById("nextBtn");
  const modalFooter = document.getElementById("modalFooter");
  const successScreen = document.getElementById("successScreen");
  const formAlert = document.getElementById("formAlert");

  // ---------------- Settings + countdown ----------------
  async function loadSettings() {
    try {
      const { data, error } = await supabase
        .from("champion_settings")
        .select("application_status, deadline")
        .eq("id", 1)
        .single();
      if (!error && data) settings = data;
    } catch (e) { /* fall back to defaults */ }
    renderDeadlineUI();
    startCountdown();
  }

  function renderDeadlineUI() {
    const d = new Date(settings.deadline);
    const formatted = d.toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" });
    document.getElementById("deadlineHeadline").textContent = formatted;
    document.getElementById("deadlineFull").textContent = formatted;

    const isClosed = settings.application_status === "closed" || Date.now() > d.getTime();
    if (isClosed) {
      document.getElementById("deadlineStatus").textContent = "Applications Closed";
      document.getElementById("deadlineStatus").style.background = "rgba(0,0,0,0.25)";
      document.getElementById("closedBanner").style.display = "block";
      ["applyNavBtn", "applyHeroBtn", "applyFooterBtn"].forEach((id) => {
        const btn = document.getElementById(id);
        if (btn) { btn.disabled = true; btn.textContent = "Applications Closed"; }
      });
    }
  }

  function startCountdown() {
    const deadline = new Date(settings.deadline).getTime();
    function tick() {
      const diff = deadline - Date.now();
      if (diff <= 0 || settings.application_status === "closed") {
        ["cdDays", "cdHours", "cdMins", "cdSecs"].forEach((id) => (document.getElementById(id).textContent = "0"));
        clearInterval(timer);
        return;
      }
      const days = Math.floor(diff / 86400000);
      const hours = Math.floor((diff % 86400000) / 3600000);
      const mins = Math.floor((diff % 3600000) / 60000);
      const secs = Math.floor((diff % 60000) / 1000);
      document.getElementById("cdDays").textContent = days;
      document.getElementById("cdHours").textContent = String(hours).padStart(2, "0");
      document.getElementById("cdMins").textContent = String(mins).padStart(2, "0");
      document.getElementById("cdSecs").textContent = String(secs).padStart(2, "0");
    }
    tick();
    const timer = setInterval(tick, 1000);
  }

  function isApplicationOpen() {
    return settings.application_status !== "closed" && Date.now() <= new Date(settings.deadline).getTime();
  }

  // ---------------- Modal open/close ----------------
  function openModal() {
    if (!isApplicationOpen()) return;
    overlay.classList.add("open");
    document.body.style.overflow = "hidden";
    currentStep = 1;
    showStep(1);
  }
  function closeModal() {
    overlay.classList.remove("open");
    document.body.style.overflow = "";
  }
  ["applyNavBtn", "applyHeroBtn", "applyFooterBtn"].forEach((id) => {
    const btn = document.getElementById(id);
    if (btn) btn.addEventListener("click", openModal);
  });
  document.getElementById("modalCloseBtn").addEventListener("click", closeModal);
  overlay.addEventListener("click", (e) => { if (e.target === overlay) closeModal(); });
  document.getElementById("successCloseBtn").addEventListener("click", () => { closeModal(); location.reload(); });

  // ---------------- Choice pills / radios / ratings ----------------
  form.querySelectorAll(".choice-pill input").forEach((input) => {
    input.addEventListener("change", () => {
      const pill = input.closest(".choice-pill");
      if (input.type === "radio") {
        form.querySelectorAll(`input[name="${input.name}"]`).forEach((i) => i.closest(".choice-pill").classList.remove("checked"));
      }
      pill.classList.toggle("checked", input.checked);
    });
  });

  form.querySelectorAll("[data-rating-group]").forEach((group) => {
    const name = group.getAttribute("data-rating-group");
    group.querySelectorAll("button").forEach((btn) => {
      btn.addEventListener("click", () => {
        group.querySelectorAll("button").forEach((b) => b.classList.remove("checked"));
        btn.classList.add("checked");
        group.dataset.value = btn.dataset.value;
      });
    });
  });

  // prior experience reveal
  form.querySelectorAll('input[name="has_prior_experience"]').forEach((radio) => {
    radio.addEventListener("change", () => {
      document.getElementById("priorExperienceReveal").classList.toggle("show", radio.value === "yes" && radio.checked);
    });
  });

  // character counters
  form.querySelectorAll("textarea[maxlength]").forEach((ta) => {
    const counter = document.querySelector(`[data-count-for="${ta.name}"]`);
    if (!counter) return;
    ta.addEventListener("input", () => (counter.textContent = ta.value.length));
  });

  // file uploads
  let photoFile = null, cvFile = null;
  const photoInput = document.getElementById("profilePhoto");
  const cvInput = document.getElementById("cvUpload");
  photoInput.addEventListener("change", () => {
    const f = photoInput.files[0];
    if (!f) return;
    if (!["image/jpeg", "image/png"].includes(f.type)) { showAlert("Profile photo must be a JPG or PNG file."); photoInput.value = ""; return; }
    if (f.size > 5 * 1024 * 1024) { showAlert("Profile photo must be under 5MB."); photoInput.value = ""; return; }
    photoFile = f;
    document.getElementById("photoName").textContent = f.name;
    document.getElementById("photoDrop").classList.add("has-file");
  });
  cvInput.addEventListener("change", () => {
    const f = cvInput.files[0];
    if (!f) return;
    const okTypes = ["application/pdf", "application/msword", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"];
    if (!okTypes.includes(f.type) && !/\.(pdf|doc|docx)$/i.test(f.name)) { showAlert("CV must be a PDF, DOC or DOCX file."); cvInput.value = ""; return; }
    if (f.size > 10 * 1024 * 1024) { showAlert("CV must be under 10MB."); cvInput.value = ""; return; }
    cvFile = f;
    document.getElementById("cvName").textContent = f.name;
    document.getElementById("cvDrop").classList.add("has-file");
  });

  // ---------------- Step navigation ----------------
  function showStep(n) {
    form.querySelectorAll(".step-panel").forEach((p) => p.classList.toggle("active", Number(p.dataset.step) === n));
    stepLabel.textContent = `Step ${n} of ${TOTAL_STEPS}`;
    progressFill.style.width = `${(n / TOTAL_STEPS) * 100}%`;
    backBtn.disabled = n === 1;
    nextBtn.textContent = n === TOTAL_STEPS ? "Submit Application" : "Continue";
    hideAlert();
    modalBody.scrollTop = 0;
  }

  function showAlert(msg) { formAlert.textContent = msg; formAlert.classList.add("show"); }
  function hideAlert() { formAlert.classList.remove("show"); }

  function markInvalid(field, msg) {
    field.closest(".field").classList.add("invalid");
    const err = field.closest(".field").querySelector(".error-msg") || document.createElement("div");
    if (!field.closest(".field").querySelector(".error-msg")) {
      err.className = "error-msg";
      field.closest(".field").appendChild(err);
    }
    err.textContent = msg;
  }
  function clearInvalid(field) {
    const f = field.closest(".field");
    if (f) f.classList.remove("invalid");
  }

  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const PHONE_RE = /^[+\d][\d\s-]{6,}$/;

  function validateStep(n) {
    let valid = true;
    const panel = form.querySelector(`.step-panel[data-step="${n}"]`);
    panel.querySelectorAll("input[required], select[required], textarea[required]").forEach((field) => {
      clearInvalid(field);
      if (!field.value.trim()) { markInvalid(field, "This field is required."); valid = false; }
    });

    if (n === 1) {
      const email = form.email;
      if (email.value && !EMAIL_RE.test(email.value)) { markInvalid(email, "Enter a valid email address."); valid = false; }
      const phone = form.phone;
      if (phone.value && !PHONE_RE.test(phone.value)) { markInvalid(phone, "Enter a valid phone number."); valid = false; }
    }

    if (n === 2) {
      const passions = form.querySelectorAll('input[name="passions"]:checked');
      if (passions.length === 0) { showAlert("Please select at least one thing you're passionate about."); valid = false; }
    }

    if (n === 5) {
      if (!photoFile) { showAlert("Please upload a profile photograph."); valid = false; }
      if (!document.getElementById("declare1").checked || !document.getElementById("declare2").checked) {
        showAlert("Please confirm both declaration checkboxes before submitting.");
        valid = false;
      }
    }

    if (!valid && n !== 2 && n !== 5) showAlert("Please complete all required fields before continuing.");
    return valid;
  }

  backBtn.addEventListener("click", () => { if (currentStep > 1) { currentStep--; showStep(currentStep); } });
  nextBtn.addEventListener("click", async () => {
    if (!validateStep(currentStep)) return;
    if (currentStep < TOTAL_STEPS) {
      currentStep++;
      showStep(currentStep);
    } else {
      await submitApplication();
    }
  });

  // ---------------- Submission ----------------
  function collectData() {
    const fd = new FormData(form);
    const get = (name) => (fd.get(name) || "").toString().trim();
    const getAll = (name) => fd.getAll(name).map(String);

    return {
      full_name: get("full_name"),
      preferred_name: get("preferred_name") || null,
      email: get("email").toLowerCase(),
      phone: get("phone"),
      whatsapp: get("whatsapp") || null,
      gender: get("gender") || null,
      age_range: get("age_range") || null,
      matric_number: get("matric_number"),
      faculty: get("faculty"),
      department: get("department"),
      level: get("level"),
      graduation_year: get("graduation_year") || null,

      introduction: get("introduction"),
      passions: getAll("passions"),
      has_prior_experience: (form.querySelector('input[name="has_prior_experience"]:checked') || {}).value === "yes",
      previous_experience: get("previous_experience") || null,
      leadership_roles: get("leadership_roles") || null,

      why_mobihealth: get("why_mobihealth"),
      champion_role: get("champion_role"),
      promotion_strategy: get("promotion_strategy"),
      one_month_idea: get("one_month_idea") || null,
      contribution_areas: getAll("contribution_areas"),

      communication_rating: Number(document.querySelector('[data-rating-group="communication_rating"]').dataset.value || 0) || null,
      public_speaking_rating: Number(document.querySelector('[data-rating-group="public_speaking_rating"]').dataset.value || 0) || null,
      social_media_activity: get("social_media_activity") || null,
      social_platforms: getAll("social_platforms"),
      weekly_availability: get("weekly_availability") || null,
      campus_events: (form.querySelector('input[name="campus_events"]:checked') || {}).value === "yes",
      social_media_sharing: (form.querySelector('input[name="social_media_sharing"]:checked') || {}).value || null,

      champion_idea: get("champion_idea") || null,
      unique_strength: get("unique_strength") || null,
      referral_source: get("referral_source") || null,
      instagram: get("instagram") || null,
      linkedin: get("linkedin") || null,
      additional_information: get("additional_information") || null,
    };
  }

  async function uploadFile(bucket, file, prefix) {
    const ext = file.name.split(".").pop();
    const path = `${prefix}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
    const { error } = await supabase.storage.from(bucket).upload(path, file, { cacheControl: "3600", upsert: false });
    if (error) throw error;
    return path;
  }

  async function submitApplication() {
    if (submitting) return;
    submitting = true;
    nextBtn.disabled = true;
    backBtn.disabled = true;
    nextBtn.innerHTML = '<span class="spinner"></span>';
    hideAlert();

    try {
      const data = collectData();

      // Duplicate check (defense-in-depth alongside the DB unique index)
      const { data: existing } = await supabase
        .from("champion_applications")
        .select("id")
        .or(`email.eq.${data.email},matric_number.eq.${data.matric_number}`)
        .limit(1);
      if (existing && existing.length > 0) {
        showAlert("An application already exists with these details. If you believe this is an error, please contact the Mobihealth team.");
        submitting = false;
        resetSubmitBtn();
        return;
      }

      const photoPath = await uploadFile("champion-photos", photoFile, "photos");
      let cvPath = null;
      if (cvFile) cvPath = await uploadFile("champion-cvs", cvFile, "cvs");

      const { data: numRow, error: numErr } = await supabase.rpc("champion_next_application_number");
      if (numErr) throw numErr;
      const applicationNumber = numRow;

      const { error: insertErr } = await supabase.from("champion_applications").insert({
        ...data,
        application_number: applicationNumber,
        profile_photo_path: photoPath,
        cv_path: cvPath,
      });
      if (insertErr) {
        if (insertErr.code === "23505") {
          showAlert("An application already exists with these details. If you believe this is an error, please contact the Mobihealth team.");
          submitting = false;
          resetSubmitBtn();
          return;
        }
        throw insertErr;
      }

      // Best-effort confirmation email (Supabase Edge Function; safe to fail silently)
      supabase.functions.invoke("champions-notify", {
        body: { email: data.email, name: data.full_name, applicationNumber },
      }).catch(() => {});

      document.getElementById("refNumber").textContent = applicationNumber;
      form.style.display = "none";
      modalFooter.style.display = "none";
      successScreen.style.display = "block";
    } catch (err) {
      console.error(err);
      showAlert("Something went wrong submitting your application. Please check your connection and try again.");
      resetSubmitBtn();
    }
    submitting = false;
  }

  function resetSubmitBtn() {
    nextBtn.disabled = false;
    backBtn.disabled = currentStep === 1;
    nextBtn.textContent = currentStep === TOTAL_STEPS ? "Submit Application" : "Continue";
  }

  loadSettings();
})();
