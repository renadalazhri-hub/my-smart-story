// Login with Google + "My stories" library, stored in Firestore under users/{uid}/stories.
// Talks to the main page script through window.mss (see the bridge at the end of the story script).
import { firebaseConfig } from "./firebase-config.js";

const FIREBASE = "https://www.gstatic.com/firebasejs/10.12.2/";
const PROMPT_SEEN_KEY = "mss_save_prompt_seen";

const mss = window.mss;
const $ = (id) => document.getElementById(id);

let fb = null; // { auth, db, authApi, store }
let user = null;
let unsaved = null; // the newest story made while signed out, saved right after login
let returnTo = "home";

function promptSeen() {
  try { return localStorage.getItem(PROMPT_SEEN_KEY) === "1"; } catch { return false; }
}
function markPromptSeen() {
  try { localStorage.setItem(PROMPT_SEEN_KEY, "1"); } catch { /* storage blocked: prompt may show again */ }
}

// Reuses the page's "copied!" toast, then puts its original text back.
function toast(message) {
  const el = $("copyToast");
  const original = el.dataset.text || (el.dataset.text = el.textContent);
  el.textContent = message;
  el.classList.add("show");
  setTimeout(() => {
    el.classList.remove("show");
    setTimeout(() => { el.textContent = original; }, 300);
  }, 2200);
}

async function loadFirebase() {
  if (fb) return fb;
  if (!firebaseConfig.apiKey) throw new Error("not_configured");
  const [app, auth, store] = await Promise.all([
    import(FIREBASE + "firebase-app.js"),
    import(FIREBASE + "firebase-auth.js"),
    import(FIREBASE + "firebase-firestore.js"),
  ]);
  const firebaseApp = app.initializeApp(firebaseConfig);
  fb = { auth: auth.getAuth(firebaseApp), db: store.getFirestore(firebaseApp), authApi: auth, store };
  fb.authApi.onAuthStateChanged(fb.auth, (u) => { user = u; });
  await fb.auth.authStateReady();
  user = fb.auth.currentUser;
  return fb;
}

// Small JPEG of the drawing so the saved story keeps its cover (fits easily in a Firestore document).
function coverThumbnail(file) {
  if (!file) return Promise.resolve(null);
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, 480 / Math.max(img.width, img.height));
      const c = document.createElement("canvas");
      c.width = Math.max(1, Math.round(img.width * scale));
      c.height = Math.max(1, Math.round(img.height * scale));
      const ctx = c.getContext("2d");
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, c.width, c.height);
      ctx.drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      resolve(c.toDataURL("image/jpeg", 0.7));
    };
    img.onerror = () => { URL.revokeObjectURL(url); resolve(null); };
    img.src = url;
  });
}

async function saveStory(entry) {
  const { db, store } = await loadFirebase();
  const cover = await coverThumbnail(entry.image);
  await store.addDoc(store.collection(db, "users", user.uid, "stories"), {
    title: entry.story.title,
    story: entry.story,
    cover,
    createdAt: store.serverTimestamp(),
  });
}

/* ---------- Save prompt ---------- */
function showSavePrompt(from, reason) {
  returnTo = from;
  $("saveError").textContent = "";
  if (reason === "library") {
    $("saveTitle").textContent = "مكتبة قصصك تنتظرك! 📚";
    $("saveLead").textContent = "سجّل دخولك وكل حكاية تصنعها تنحفظ في مكتبتك، ترجع لها وتقرأها متى ما تبي.";
  } else {
    $("saveTitle").textContent = "لا تخلّي حكايتك تضيع!";
    $("saveLead").textContent = "حكايتك كانت رائعة! 🌟 بس انتبه: إذا طلعت من الموقع بتختفي 😢 سجّل دخولك وخلّ كل حكاية تصنعها محفوظة لك دايم.";
  }
  mss.showScreen("save");
}

$("btnSaveSkip").addEventListener("click", () => mss.showScreen(returnTo));

$("btnSaveLogin").addEventListener("click", async () => {
  const btn = $("btnSaveLogin");
  $("saveError").textContent = "";
  btn.disabled = true;
  try {
    const { auth, authApi } = await loadFirebase();
    if (!user) {
      const result = await authApi.signInWithPopup(auth, new authApi.GoogleAuthProvider());
      user = result.user;
    }
    if (unsaved) {
      await saveStory(unsaved);
      unsaved = null;
      toast("تم حفظ حكايتك في مكتبتك ✅");
    }
    openLibrary();
  } catch (err) {
    const code = (err && err.code) || (err && err.message) || "";
    if (code === "auth/popup-closed-by-user" || code === "auth/cancelled-popup-request") {
      // the user closed the Google window; nothing to report
    } else if (code === "not_configured") {
      $("saveError").textContent = "حفظ القصص غير مفعّل في الموقع بعد. جرّب لاحقًا 🙏";
    } else if (code === "auth/popup-blocked") {
      $("saveError").textContent = "المتصفح منع نافذة الدخول. اسمح بالنوافذ المنبثقة لهذا الموقع وجرّب مرة ثانية.";
    } else {
      console.error(err);
      $("saveError").textContent = "ما قدرنا نسجّل الدخول الحين، جرّب مرة ثانية بعد شوي.";
    }
  } finally {
    btn.disabled = false;
  }
});

/* ---------- Library ---------- */
function formatDate(ts) {
  try { return ts.toDate().toLocaleDateString("ar-SA", { day: "numeric", month: "long", year: "numeric" }); }
  catch { return ""; }
}

async function openLibrary() {
  mss.showScreen("library");
  const grid = $("libGrid");
  const hint = $("libHint");
  grid.innerHTML = "";
  hint.textContent = "جاري تحميل قصصك...";
  try {
    const { db, store } = await loadFirebase();
    if (!user) { showSavePrompt("home", "library"); return; }
    const snap = await store.getDocs(store.query(
      store.collection(db, "users", user.uid, "stories"),
      store.orderBy("createdAt", "desc"),
      store.limit(60),
    ));
    hint.textContent = snap.empty
      ? "مكتبتك فاضية للحين، اصنع أول حكاية وبتنحفظ هنا تلقائيًا ✨"
      : `عندك ${snap.size} ${snap.size === 1 ? "حكاية" : "حكايات"} محفوظة. اختر وحدة واقرأها من جديد!`;
    snap.forEach((docSnap) => grid.appendChild(libraryCard(docSnap)));
  } catch (err) {
    console.error(err);
    hint.textContent = "ما قدرنا نحمّل مكتبتك الحين، جرّب مرة ثانية بعد شوي.";
  }
}

function libraryCard(docSnap) {
  const data = docSnap.data();
  const card = document.createElement("div");
  card.className = "lib-item";
  card.setAttribute("role", "button");
  card.tabIndex = 0;

  const cover = document.createElement("div");
  cover.className = "lib-cover";
  if (data.cover) {
    const img = document.createElement("img");
    img.src = data.cover;
    img.alt = "";
    cover.appendChild(img);
  } else {
    cover.textContent = "📖";
  }
  const title = document.createElement("span");
  title.className = "lib-title";
  title.textContent = data.title || "حكاية بدون عنوان";
  const date = document.createElement("span");
  date.className = "lib-date";
  date.textContent = formatDate(data.createdAt);

  const del = document.createElement("button");
  del.type = "button";
  del.className = "lib-del";
  del.setAttribute("aria-label", "حذف الحكاية");
  del.textContent = "🗑️";
  del.addEventListener("click", async (e) => {
    e.stopPropagation();
    if (!confirm("متأكد تبي تحذف هذي الحكاية؟")) return;
    try {
      await fb.store.deleteDoc(docSnap.ref);
      card.remove();
    } catch (err) {
      console.error(err);
      toast("ما قدرنا نحذفها، جرّب مرة ثانية");
    }
  });

  const open = () => mss.openStory(data.story, data.cover);
  card.addEventListener("click", open);
  card.addEventListener("keydown", (e) => { if (e.key === "Enter") open(); });
  card.append(cover, title, date, del);
  return card;
}

$("btnLibBack").addEventListener("click", () => mss.showScreen("home"));
$("btnLibNew").addEventListener("click", () => mss.showScreen("upload"));
$("btnSignOut").addEventListener("click", async () => {
  try { if (fb) await fb.authApi.signOut(fb.auth); } catch (err) { console.error(err); }
  user = null;
  mss.showScreen("home");
});

function onLibraryButton(from) {
  if (user) openLibrary();
  else showSavePrompt(from, "library");
}
$("btnLibrary").addEventListener("click", () => onLibraryButton("home"));
$("btnEndLibrary").addEventListener("click", () => onLibraryButton("story"));

/* ---------- Hooks from the story flow ---------- */
mss.onStoryCreated = (entry) => {
  if (user) {
    saveStory(entry).then(() => toast("انحفظت حكايتك في مكتبتك ✅")).catch((err) => console.error(err));
  } else {
    unsaved = entry;
  }
};

mss.onStoryFinished = () => {
  if (!user && !promptSeen()) {
    markPromptSeen();
    showSavePrompt("story", "first-story");
  }
};

// Restore an existing session quietly so signed-in users don't see the prompt.
if (firebaseConfig.apiKey) loadFirebase().catch((err) => console.error(err));
