const STORAGE_KEY = "weekly-schedule-v1";
const SCHEDULE_NOTIFICATION_PREFERENCE_KEY = "weekly-notification-schedule-enabled-v1";
const REQUEST_NOTIFICATION_PREFERENCE_KEY = "weekly-notification-request-enabled-v1";

const STATUS_OPTIONS = ["現場", "内業", "打合せ", "移動", "営業", "事務", "総務", "休み", "午前休", "午後休", "有給", "午前有休", "午後有休"];
const HALF_DAY_SECONDARY_STATUS_OPTIONS = ["現場", "内業", "打合せ", "移動", "営業", "事務", "総務"];
const DEFAULT_STAFF_ACCOUNTS = [
  { id: "本社A", name: "本社A" },
  { id: "本社B", name: "本社B" },
  { id: "支社A", name: "支社A" },
  { id: "支社B", name: "支社B" },
  { id: "支社C", name: "支社C" },
  { id: "支社D", name: "支社D" },
];
const WEEKDAY_LABELS = ["日", "月", "火", "水", "木", "金", "土"];
const AUTH_EMAIL_DOMAIN = "schedule.local";
const ADMIN_LOGIN_ID = "イオリ技研";
const ADMIN_LOGIN_ID_ALIASES = ["イオリ技建"];
const ADMIN_PASSWORD = "123456";
const ADMIN_AUTH_LOCAL_PART = "__admin_root_v1";
const AUTH_PROFILE_MAP_KEY = "weekly-auth-profile-map-v1";

const pageMode = document.body?.dataset?.page || "home";
const isPersonalPage = pageMode === "personal";
const isOverallPage = pageMode === "overall";
const isAdminPage = pageMode === "admin";
const requiresAuth = pageMode === "personal" || pageMode === "overall" || pageMode === "admin";
const FIRESTORE_COLLECTION = "appData";
const FIRESTORE_DOCUMENT = "weeklySchedule";

let firestoreDb = null;
let firebaseAuth = null;
let cloudSyncEnabled = false;
let cloudSaveTimer = null;
let cloudLoading = false;
let cloudUnsubscribe = null;
let lastKnownRemoteUpdatedAt = "";
let lastLocalSaveUpdatedAt = "";
let syncAlertTimer = null;
let currentFirebaseUser = null;
let authObserverReady = false;
let appReady = false;
let pendingLoginId = "";
let pendingLoginDisplayName = "";
let pendingLoginPassword = "";
let authProfileMap = {};
let loginInFlight = false;
let loginBlockedUntil = 0;
let scheduleNotificationEnabled = true;
let requestNotificationEnabled = true;
let tableScrollbarSyncing = false;
let tableScrollbarResizeBound = false;
let desktopRequestPanelEl = null;
let desktopRequestListEl = null;
let scheduleFinalizeRequired = false;
let finalizeInFlight = false;

const LOGIN_BLOCK_MS_AFTER_TOO_MANY_REQUESTS = 60 * 1000;

const state = {
  currentWeekStart: getMonday(new Date()),
  currentMonthStart: getMonthStart(new Date()),
  staff: DEFAULT_STAFF_ACCOUNTS.map((item) => item.name),
  staffAccounts: DEFAULT_STAFF_ACCOUNTS.map((item) => toStaffAccount(item)),
  currentUser: "",
  currentUserId: "",
  isAdmin: false,
  manualEntries: {},
  settings: {
    holidayAutoEnabled: true,
    dullStartMonth: 1,
    dullEndMonth: 3,
    busyStartMonth: 4,
    busyEndMonth: 12,
    biweeklyPattern: "1-3",
  },
  holidaysByYear: {},
  editTarget: null,
  confirmationRequests: [],
  weeklyBusinessNotes: {},
};

const refs = {
  prevWeekBtn: document.getElementById("prevWeekBtn"),
  nextWeekBtn: document.getElementById("nextWeekBtn"),
  prevMonthBtn: document.getElementById("prevMonthBtn"),
  nextMonthBtn: document.getElementById("nextMonthBtn"),
  currentMonthBtn: document.getElementById("currentMonthBtn"),
  finalizeScheduleBtn: document.getElementById("finalizeScheduleBtn"),
  todayBtn: document.getElementById("todayBtn"),
  weekLabel: document.getElementById("weekLabel"),
  monthLabel: document.getElementById("monthLabel"),
  scheduleTable: document.getElementById("scheduleTable"),
  monthlyScheduleTable: document.getElementById("monthlyScheduleTable"),
  scheduleScrollbar: document.getElementById("scheduleScrollbar"),
  scheduleScrollbarInner: document.getElementById("scheduleScrollbarInner"),
  notice: document.getElementById("notice"),
  currentUserLabel: document.getElementById("currentUserLabel"),
  openLoginBtn: document.getElementById("openLoginBtn"),
  logoutBtn: document.getElementById("logoutBtn"),
  toggleSettingsBtn: document.getElementById("toggleSettingsBtn"),
  settingsPanel: document.getElementById("settingsPanel"),
  holidayAutoEnabled: document.getElementById("holidayAutoEnabled"),
  dullStartMonth: document.getElementById("dullStartMonth"),
  dullEndMonth: document.getElementById("dullEndMonth"),
  busyStartMonth: document.getElementById("busyStartMonth"),
  busyEndMonth: document.getElementById("busyEndMonth"),
  biweeklyPattern: document.getElementById("biweeklyPattern"),
  saveSettingsBtn: document.getElementById("saveSettingsBtn"),
  editDialog: document.getElementById("editDialog"),
  editForm: document.getElementById("editForm"),
  editMeta: document.getElementById("editMeta"),
  statusInput: document.getElementById("statusInput"),
  secondaryStatusRow: document.getElementById("secondaryStatusRow"),
  secondaryStatusLabel: document.getElementById("secondaryStatusLabel"),
  secondaryStatusInput: document.getElementById("secondaryStatusInput"),
  workInputLabel: document.getElementById("workInputLabel"),
  workInput: document.getElementById("workInput"),
  placeInputLabel: document.getElementById("placeInputLabel"),
  placeInput: document.getElementById("placeInput"),
  halfDayWorkHint: document.getElementById("halfDayWorkHint"),
  repeatEnabled: document.getElementById("repeatEnabled"),
  repeatCount: document.getElementById("repeatCount"),
  requestConfirmEnabled: document.getElementById("requestConfirmEnabled"),
  requestTargetInput: document.getElementById("requestTargetInput"),
  requestMessageInput: document.getElementById("requestMessageInput"),
  clearEntryBtn: document.getElementById("clearEntryBtn"),
  cancelEntryBtn: document.getElementById("cancelEntryBtn"),
  loginDialog: document.getElementById("loginDialog"),
  loginForm: document.getElementById("loginForm"),
  loginIdInput: document.getElementById("loginIdInput"),
  loginPasswordInput: document.getElementById("loginPasswordInput"),
  loginCancelBtn: document.getElementById("loginCancelBtn"),
  registerNameInput: document.getElementById("registerNameInput"),
  registerBirthdayInput: document.getElementById("registerBirthdayInput"),
  registerUserBtn: document.getElementById("registerUserBtn"),
  toggleRegisterBtn: document.getElementById("toggleRegisterBtn"),
  registerPanel: document.getElementById("registerPanel"),
  userOrderList: document.getElementById("userOrderList"),
  changePasswordUserSelect: document.getElementById("changePasswordUserSelect"),
  newPasswordInput: document.getElementById("newPasswordInput"),
  changePasswordBtn: document.getElementById("changePasswordBtn"),
  adminSettingsSection: document.getElementById("adminSettingsSection"),
  adminRegisterSection: document.getElementById("adminRegisterSection"),
  adminOnlyNotice: document.getElementById("adminOnlyNotice"),
  enableNotificationsBtn: document.getElementById("enableNotificationsBtn"),
  toggleScheduleNotificationsBtn: document.getElementById("toggleScheduleNotificationsBtn"),
  toggleRequestNotificationsBtn: document.getElementById("toggleRequestNotificationsBtn"),
  notificationStatus: document.getElementById("notificationStatus"),
  syncAlert: document.getElementById("syncAlert"),
  requestInboxSection: document.getElementById("requestInboxSection"),
  requestInboxList: document.getElementById("requestInboxList"),
  personalBusinessNoteSection: document.getElementById("personalBusinessNoteSection"),
  businessNoteInput: document.getElementById("businessNoteInput"),
  saveBusinessNoteBtn: document.getElementById("saveBusinessNoteBtn"),
  businessNoteMeta: document.getElementById("businessNoteMeta"),
  overallBusinessNoteSection: document.getElementById("overallBusinessNoteSection"),
  overallBusinessNoteList: document.getElementById("overallBusinessNoteList"),
};

function openDialog(dialog) {
  if (!dialog) {
    return;
  }

  if (typeof dialog.showModal === "function") {
    try {
      if (!dialog.open) {
        dialog.showModal();
      }
      return;
    } catch (error) {
      // showModal が例外になる環境では open 属性フォールバックを使う
    }
  }

  dialog.setAttribute("open", "");
}

function closeDialog(dialog) {
  if (!dialog) {
    return;
  }

  if (typeof dialog.close === "function") {
    dialog.close();
    return;
  }

  dialog.removeAttribute("open");
}

init();

async function init() {
  initCloudStore();
  loadAuthProfileMap();
  loadNotificationPreferences();
  await waitForInitialAuthState();
  await loadState();
  let currentUserAddedToStaff = false;

  // 初期ロード時は waitForInitialAuthState が handleAuthStateChanged を呼ばないため
  // ここで管理者判定とページアクセス制御を実行する
  if (currentFirebaseUser) {
    const cachedProfile = getAuthProfile(currentFirebaseUser);
    if (cachedProfile?.loginId) {
      state.currentUserId = normalizeLoginId(cachedProfile.loginId);
      state.currentUser = normalizeDisplayName(cachedProfile.displayName || cachedProfile.loginId);
    } else {
      const authLoginId = getLoginIdFromAuthUser(currentFirebaseUser);
      if (authLoginId) {
        state.currentUserId = authLoginId;
        const account = findAccountByLoginId(authLoginId);
        state.currentUser = account?.name || authLoginId;
      }
    }

    state.isAdmin = await detectAdminUser(currentFirebaseUser);

    // 管理者は管理者ページのみ許可
    if (state.isAdmin && !isAdminPage) {
      window.location.href = "admin.html";
      return;
    }
    // 非管理者が管理者ページに直アクセスした場合は全体ページへ
    if (!state.isAdmin && isAdminPage) {
      window.location.href = "overall.html";
      return;
    }

    currentUserAddedToStaff = ensureCurrentUserInStaffAccounts();
  } else if (isAdminPage) {
    // 管理者ページはログイン地点にしない。通常ページからログインして遷移させる。
    window.location.href = "overall.html";
    return;
  }

  state.currentWeekStart = getMonday(new Date());

  buildMonthOptions();
  syncLoginForm();
  syncAuthUi();
  syncAdminUi();
  syncSettingsToForm();
  syncNotificationUi();
  bindEvents();
  ensureDesktopRequestPanel();
  bindTableScrollbarSync();
  updatePageLock();

  if (currentFirebaseUser) {
    startCloudListener();
    if (currentUserAddedToStaff) {
      saveState();
    }
  }

  appReady = true;
  await render();

  if (requiresAuth && !currentFirebaseUser && refs.loginDialog) {
    openDialog(refs.loginDialog);
  }
}

function bindEvents() {
  if (refs.prevWeekBtn) {
    refs.prevWeekBtn.addEventListener("click", async () => {
      state.currentWeekStart = addDays(state.currentWeekStart, -7);
      await render();
    });
  }

  if (refs.nextWeekBtn) {
    refs.nextWeekBtn.addEventListener("click", async () => {
      state.currentWeekStart = addDays(state.currentWeekStart, 7);
      await render();
    });
  }

  if (refs.todayBtn) {
    refs.todayBtn.addEventListener("click", async () => {
      state.currentWeekStart = getMonday(new Date());
      await render();
    });
  }

  if (refs.prevMonthBtn) {
    refs.prevMonthBtn.addEventListener("click", async () => {
      state.currentMonthStart = addMonths(state.currentMonthStart, -1);
      await render();
    });
  }

  if (refs.nextMonthBtn) {
    refs.nextMonthBtn.addEventListener("click", async () => {
      state.currentMonthStart = addMonths(state.currentMonthStart, 1);
      await render();
    });
  }

  if (refs.currentMonthBtn) {
    refs.currentMonthBtn.addEventListener("click", async () => {
      state.currentMonthStart = getMonthStart(new Date());
      await render();
    });
  }

  if (refs.finalizeScheduleBtn) {
    refs.finalizeScheduleBtn.addEventListener("click", () => {
      if (!currentFirebaseUser) {
        setNotice("ログイン後に確定通知できます。");
        return;
      }
      if (!scheduleFinalizeRequired) {
        setNotice("未確定の入力はありません。変更後に確定通知してください。");
        return;
      }
      if (finalizeInFlight) {
        return;
      }

      finalizeInFlight = true;
      syncFinalizeButtonUi();
      saveState({ announce: true });
      scheduleFinalizeRequired = false;
      finalizeInFlight = false;
      syncFinalizeButtonUi();
      setNotice("入力内容を確定し、他の利用者へ通知しました。");
    });
  }

  if (refs.saveBusinessNoteBtn && refs.businessNoteInput) {
    refs.saveBusinessNoteBtn.addEventListener("click", () => {
      const loginId = normalizeLoginId(state.currentUserId);
      if (!loginId) {
        setNotice("業務欄を保存するにはログインが必要です。");
        return;
      }

      const weekStartIso = toISODate(getMonday(new Date()));
      const key = getWeeklyBusinessNoteKey(loginId, weekStartIso);
      const text = String(refs.businessNoteInput.value || "").trim();

      if (!text) {
        delete state.weeklyBusinessNotes[key];
      } else {
        state.weeklyBusinessNotes[key] = {
          text,
          updatedAt: new Date().toISOString(),
          updatedById: loginId,
          updatedByName: state.currentUser || loginId,
        };
      }

      saveWeeklyBusinessNotesImmediately();
      renderWeeklyBusinessNotes();
      setNotice("業務欄を保存しました。全体ページへ即時反映しました。");
    });
  }

  if (refs.toggleSettingsBtn && refs.settingsPanel) {
    refs.toggleSettingsBtn.addEventListener("click", () => {
      if (!canManageAdminSettings()) {
        setNotice("管理者のみ操作できます。");
        return;
      }
      refs.settingsPanel.classList.toggle("hidden");
    });
  }

  if (refs.openLoginBtn && refs.loginDialog) {
    const handler = () => {
      console.log('openLoginBtn clicked');
      openDialog(refs.loginDialog);
    };
    refs.openLoginBtn.addEventListener("click", handler);
    refs.openLoginBtn.addEventListener("touchend", (e) => {
      e.preventDefault();
      handler();
    });
  } else {
    console.warn("openLoginBtn or loginDialog not found:", {
      openLoginBtn: !!refs.openLoginBtn,
      loginDialog: !!refs.loginDialog
    });
  }

  if (refs.enableNotificationsBtn) {
    refs.enableNotificationsBtn.addEventListener("click", async () => {
      await requestBrowserNotificationPermission();
    });
  }

  if (refs.toggleScheduleNotificationsBtn) {
    refs.toggleScheduleNotificationsBtn.addEventListener("click", () => {
      if (!("Notification" in window) || Notification.permission !== "granted") {
        setNotice("先に端末通知を有効化してください。");
        return;
      }
      setScheduleNotificationEnabled(!scheduleNotificationEnabled);
      setNotice(scheduleNotificationEnabled
        ? "更新通知を有効にしました。"
        : "更新通知を無効にしました。");
    });
  }

  if (refs.toggleRequestNotificationsBtn) {
    refs.toggleRequestNotificationsBtn.addEventListener("click", () => {
      if (!("Notification" in window) || Notification.permission !== "granted") {
        setNotice("先に端末通知を有効化してください。");
        return;
      }
      setRequestNotificationEnabled(!requestNotificationEnabled);
      setNotice(requestNotificationEnabled
        ? "確認依頼通知を有効にしました。"
        : "確認依頼通知を無効にしました。");
    });
  }

  if (refs.loginForm && refs.loginIdInput && refs.loginPasswordInput) {
    refs.loginForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      const loginId = normalizeLoginId(refs.loginIdInput.value);
      const loginPassword = normalizeLoginPassword(refs.loginPasswordInput.value);
      if (!loginId) {
        return;
      }
      if (!firebaseAuth) {
        setNotice("Firebase Authentication の設定が未完了です。");
        return;
      }

      if (isAdminLoginId(loginId) && !isAdminCredential(loginId, loginPassword)) {
        setNotice("管理者IDのパスワードが正しくありません。");
        return;
      }

      if (loginInFlight) {
        return;
      }

      const blockedRemainingMs = loginBlockedUntil - Date.now();
      if (blockedRemainingMs > 0) {
        const waitSec = Math.ceil(blockedRemainingMs / 1000);
        setNotice(`ログイン待機中です。${waitSec}秒後に再試行してください。`);
        return;
      }

      state.currentUser = normalizeDisplayName(refs.loginIdInput.value);
      state.currentUserId = loginId;
  pendingLoginId = loginId;
  pendingLoginDisplayName = state.currentUser;
  pendingLoginPassword = loginPassword;

      loginInFlight = true;
      try {
        await ensureAdminAccount(loginId, loginPassword);
        await signInWithLoginId(loginId, loginPassword);
      } catch (error) {
        if (error?.code === "auth/too-many-requests") {
          loginBlockedUntil = Date.now() + LOGIN_BLOCK_MS_AFTER_TOO_MANY_REQUESTS;
        }

        const migrated = await migrateLegacyAccountOnLogin(loginId, loginPassword, error);
        if (!migrated) {
          pendingLoginPassword = "";
          console.warn("signInWithEmailAndPassword failed", {
            code: error?.code || "",
            message: error?.message || "",
          });
          setNotice(convertFirebaseAuthError(error));
        }
      } finally {
        loginInFlight = false;
      }
    });
  }

  if (refs.logoutBtn) {
    refs.logoutBtn.addEventListener("click", async () => {
      if (!firebaseAuth) {
        return;
      }
      await firebaseAuth.signOut();
    });
  }

  if (refs.loginCancelBtn && refs.loginDialog) {
    refs.loginCancelBtn.addEventListener("click", () => {
      closeDialog(refs.loginDialog);
    });
  }

  if (refs.saveSettingsBtn) {
    refs.saveSettingsBtn.addEventListener("click", async () => {
      if (!canManageAdminSettings()) {
        setNotice("管理者のみ操作できます。");
        return;
      }
      if (!refs.holidayAutoEnabled) {
        return;
      }

      state.settings.holidayAutoEnabled = refs.holidayAutoEnabled.checked;
      state.settings.dullStartMonth = Number(refs.dullStartMonth?.value || state.settings.dullStartMonth);
      state.settings.dullEndMonth = Number(refs.dullEndMonth?.value || state.settings.dullEndMonth);
      state.settings.busyStartMonth = Number(refs.busyStartMonth?.value || state.settings.busyStartMonth);
      state.settings.busyEndMonth = Number(refs.busyEndMonth?.value || state.settings.busyEndMonth);
      state.settings.biweeklyPattern = refs.biweeklyPattern?.value || state.settings.biweeklyPattern;

      saveState();
      setNotice("休日設定を保存しました。");
      await render();
    });
  }

  if (refs.toggleRegisterBtn && refs.registerPanel) {
    refs.toggleRegisterBtn.addEventListener("click", () => {
      if (!canManageAdminSettings()) {
        setNotice("管理者のみ操作できます。");
        return;
      }
      refs.registerPanel.classList.toggle("hidden");
    });
  }

  if (refs.registerUserBtn && refs.registerNameInput && refs.registerBirthdayInput) {
    refs.registerUserBtn.addEventListener("click", async () => {
      if (!canManageAdminSettings()) {
        setNotice("管理者のみ操作できます。");
        return;
      }
      const displayName = normalizeDisplayName(refs.registerNameInput.value);
      const loginId = normalizeLoginId(displayName);
      const registerPassword = normalizeLoginPassword(refs.registerBirthdayInput.value);

      if (!displayName) {
        setNotice("名前（ID）を入力してください。");
        return;
      }
      if (!/^\d{8}$/.test(registerPassword)) {
        setNotice("パスワードは任意の8桁の数字で入力してください。");
        return;
      }
      if (!firebaseAuth) {
        setNotice("Firebase Authentication の設定が未完了です。");
        return;
      }
      if (findAccountByLoginId(loginId)) {
        setNotice("同じ名前（ID）はすでに登録されています。");
        return;
      }

      try {
        if (isPersonalPage) {
          state.currentUser = displayName;
          state.currentUserId = loginId;
          await firebaseAuth.createUserWithEmailAndPassword(buildAuthEmail(loginId), registerPassword);
        } else {
          await createUserWithoutSwitchingSession(buildAuthEmail(loginId), registerPassword);
        }

        state.staffAccounts.push(toStaffAccount({ id: loginId, name: displayName }));
        const createdAccount = findAccountByLoginId(loginId);
        if (createdAccount) {
          createdAccount.password = registerPassword;
        }
        refreshStaffFromAccounts();
        saveState();

        refs.registerNameInput.value = "";
        refs.registerBirthdayInput.value = "";

        if (isPersonalPage && refs.loginIdInput && refs.loginPasswordInput) {
          refs.loginIdInput.value = displayName;
          refs.loginPasswordInput.value = "";
          refs.loginPasswordInput.focus();
        }

        setNotice(`${displayName} を新規登録しました。ログインできます。`);
        await render();
      } catch (error) {
        setNotice(convertFirebaseAuthError(error));
      }
    });
  }

  if (refs.changePasswordBtn && refs.changePasswordUserSelect && refs.newPasswordInput) {
    refs.changePasswordBtn.addEventListener("click", async () => {
      if (!canManageAdminSettings() || !state.isAdmin) {
        setNotice("管理者のみ操作できます。");
        return;
      }

      const targetId = normalizeLoginId(refs.changePasswordUserSelect.value);
      const newPassword = normalizeLoginPassword(refs.newPasswordInput.value);

      if (!targetId) {
        setNotice("対象利用者を選択してください。");
        return;
      }
      if (!/^\d{8}$/.test(newPassword)) {
        setNotice("新しいパスワードは任意の8桁の数字で入力してください。");
        return;
      }
      if (!firebaseAuth) {
        setNotice("Firebase Authentication の設定が未完了です。");
        return;
      }

      const targetAccount = findAccountByLoginId(targetId);
      if (!targetAccount) {
        setNotice("対象利用者が見つかりません。");
        return;
      }
      const currentPassword = normalizeLoginPassword(targetAccount.password || "");
      if (!currentPassword) {
        setNotice("対象利用者の現行パスワード情報が未登録のため変更できません。利用者本人で一度ログイン後に再実行してください。");
        return;
      }
      if (currentPassword === newPassword) {
        setNotice("新しいパスワードは前のパスワードと別にしてください。");
        return;
      }
      const targetName = targetAccount?.name || targetId;

      try {
        await changeUserPasswordWithoutSwitchingSession(targetId, currentPassword, newPassword);
        targetAccount.password = newPassword;
        saveState();
        refs.newPasswordInput.value = "";
        setNotice(`${targetName} のパスワードを変更しました。`);
      } catch (error) {
        const code = error?.code || "";
        if (
          code === "auth/wrong-password"
          || code === "auth/invalid-login-credentials"
          || code === "auth/invalid-credential"
          || code === "auth/user-not-found"
        ) {
          setNotice("管理データ上の現行パスワードと一致せず変更できません。対象利用者に再ログインしてもらってから再実行してください。");
          return;
        }
        if (code === "auth/weak-password") {
          setNotice("新しいパスワードは任意の8桁の数字で入力してください。");
          return;
        }
        setNotice(convertFirebaseAuthError(error));
      }
    });
  }

  if (refs.userOrderList) {
    refs.userOrderList.addEventListener("click", async (event) => {
      if (!canManageAdminSettings()) {
        setNotice("管理者のみ操作できます。");
        return;
      }
      const target = event.target;
      if (!(target instanceof HTMLElement)) {
        return;
      }

      const button = target.closest("button[data-action]");
      if (!button) {
        return;
      }

      const action = button.dataset.action;
      const index = Number(button.dataset.index);
      if (Number.isNaN(index)) {
        return;
      }

      if (action === "edit-name") {
        const targetAccount = state.staffAccounts[index];
        if (!targetAccount) {
          return;
        }

        const nextNameRaw = prompt("新しい表示名を入力してください", targetAccount.name);
        if (nextNameRaw === null) {
          return;
        }

        const nextName = normalizeDisplayName(nextNameRaw);
        if (!nextName) {
          setNotice("名前を入力してください。");
          return;
        }
        if (nextName === targetAccount.name) {
          return;
        }
        if (state.staffAccounts.some((account, i) => i !== index && account.name === nextName)) {
          setNotice("同じ表示名はすでに存在します。");
          return;
        }

        const prevName = targetAccount.name;
        targetAccount.name = nextName;
        renameManualEntriesByUserName(prevName, nextName);

        if (state.currentUser === prevName) {
          state.currentUser = nextName;
        }

        refreshStaffFromAccounts();
        saveState();
        setNotice(`表示名を ${prevName} から ${nextName} に変更しました。`);
        await render();
        return;
      }

      if (action === "delete") {
        const targetAccount = state.staffAccounts[index];
        if (!targetAccount) {
          return;
        }

        const ok = confirm(`${targetAccount.name} を削除します。よろしいですか？`);
        if (!ok) {
          return;
        }

        state.staffAccounts.splice(index, 1);
        deleteManualEntriesByUserName(targetAccount.name);

        if (state.currentUser === targetAccount.name) {
          state.currentUser = "";
          state.currentUserId = "";
        }

        refreshStaffFromAccounts();
        saveState();
        setNotice(`${targetAccount.name} を削除しました。`);
        await render();
        return;
      }

      const moved = moveStaffAccount(index, action === "up" ? -1 : 1);
      if (!moved) {
        return;
      }

      refreshStaffFromAccounts();
      saveState();
      setNotice("表示順を更新しました。");
      await render();
    });
  }

  if (refs.editForm) {
    refs.editForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      if (!state.editTarget) {
        return;
      }
      if (!canEditRow(state.editTarget.name)) {
        setNotice("本人の行、または管理者として編集できます。");
        return;
      }

      const entryData = {
        status: refs.statusInput?.value || "現場",
        secondaryStatus: "",
        work: refs.workInput?.value.trim() || "",
        place: refs.placeInput?.value.trim() || "",
        source: "manual",
        updatedAt: new Date().toISOString(),
      };

      if (getHalfDayWorkingSlot(entryData.status)) {
        const secondaryStatus = String(refs.secondaryStatusInput?.value || "").trim();
        if (!secondaryStatus) {
          setNotice("半日休ステータス時は、もう半日の状態を選択してください。");
          return;
        }
        entryData.secondaryStatus = secondaryStatus;
      }

      const repeatDays = refs.repeatEnabled?.checked ? Number(refs.repeatCount?.value || 1) : 1;
      const requiresConfirmation = Boolean(refs.requestConfirmEnabled?.checked);

      if (requiresConfirmation) {
        const requesterId = normalizeLoginId(state.currentUserId);
        const requesterName = normalizeDisplayName(state.currentUser || requesterId);
        const targetId = normalizeLoginId(refs.requestTargetInput?.value || "");
        const targetAccount = findAccountByLoginId(targetId);

        if (!requesterId) {
          setNotice("確認依頼を送るにはログインが必要です。");
          return;
        }
        if (!targetId || !targetAccount) {
          setNotice("確認相手を選択してください。");
          return;
        }
        if (requesterId === targetId) {
          setNotice("自分自身には確認依頼できません。");
          return;
        }

        state.confirmationRequests.push({
          id: createRequestId(),
          status: "pending",
          createdAt: new Date().toISOString(),
          requesterId,
          requesterName,
          targetId,
          targetName: targetAccount.name,
          ownerName: state.editTarget.name,
          startDate: state.editTarget.date,
          repeatDays: clamp(repeatDays, 1, 12),
          entryData,
          message: normalizeDisplayName(refs.requestMessageInput?.value || ""),
        });

        trimResolvedRequests();
        saveState();
        closeDialog(refs.editDialog);
        setNotice(`${targetAccount.name} に確認依頼を送りました。承認後に予定へ反映されます。`);
        await render();
        return;
      }

      const savedCount = saveManualEntriesWithRepeat(state.editTarget.name, state.editTarget.date, entryData, repeatDays);
      saveState({ localOnly: isPersonalPage });
      closeDialog(refs.editDialog);
      setNotice(`予定を保存しました。${savedCount}件反映`);
      await render();
    });
  }

  if (refs.statusInput) {
    refs.statusInput.addEventListener("change", () => {
      const status = refs.statusInput?.value || "";
      syncHalfDayInputUi(status);
      syncHalfDaySecondaryStatusUi(status);
    });
  }

  if (refs.clearEntryBtn) {
    refs.clearEntryBtn.addEventListener("click", async () => {
      if (!state.editTarget) {
        return;
      }
      if (!canEditRow(state.editTarget.name)) {
        setNotice("本人の行、または管理者として編集できます。");
        return;
      }

      const key = entryKey(state.editTarget.name, state.editTarget.date);
      delete state.manualEntries[key];
      markScheduleNeedsFinalize();
      saveState({ localOnly: isPersonalPage });
      closeDialog(refs.editDialog);
      setNotice("手動入力を解除しました。");
      await render();
    });
  }

  if (refs.cancelEntryBtn) {
    refs.cancelEntryBtn.addEventListener("click", () => {
      closeDialog(refs.editDialog);
    });
  }

  if (refs.requestConfirmEnabled) {
    refs.requestConfirmEnabled.addEventListener("change", () => {
      syncRequestFormUi();
    });
  }

  if (refs.requestInboxList) {
    refs.requestInboxList.addEventListener("click", async (event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) {
        return;
      }

      const button = target.closest("button[data-request-action]");
      if (!button) {
        return;
      }

      const action = button.dataset.requestAction;
      const requestId = String(button.dataset.requestId || "");
      if (!requestId || !action) {
        return;
      }

      await handleConfirmationRequestAction(requestId, action);
    });
  }
}

function initCloudStore() {
  const config = window.__FIREBASE_CONFIG__;
  if (!config || !config.projectId || config.projectId === "YOUR_PROJECT_ID") {
    return;
  }

  if (!window.firebase || !window.firebase.firestore || !window.firebase.auth) {
    return;
  }

  if (!window.firebase.apps.length) {
    window.firebase.initializeApp(config);
  }

  firebaseAuth = window.firebase.auth();
  firestoreDb = window.firebase.firestore();
  cloudSyncEnabled = true;
}

function waitForInitialAuthState() {
  if (!firebaseAuth) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    firebaseAuth.onAuthStateChanged(async (user) => {
      currentFirebaseUser = user;

      if (!authObserverReady) {
        authObserverReady = true;
        resolve();
        return;
      }

      if (appReady) {
        await handleAuthStateChanged(user);
      }
    });
  });
}

async function render() {
  if (requiresAuth && !currentFirebaseUser) {
    return;
  }

  const weekDates = getWeekDates(state.currentWeekStart);
  await ensureHolidayCache(weekDates);

  renderWeekLabel(weekDates);
  renderTable(weekDates);
  renderWeeklyBusinessNotes();
  renderMonthlyCalendar();
  renderUserOrderList();
  renderPasswordChangeUserOptions();
  renderRequestInbox();
  renderDesktopRequestPanel();
  syncFinalizeButtonUi();
}

function renderWeeklyBusinessNotes() {
  const weekStartIso = toISODate(getMonday(new Date()));

  if (isPersonalPage && refs.personalBusinessNoteSection && refs.businessNoteInput) {
    const loginId = normalizeLoginId(state.currentUserId);
    const key = getWeeklyBusinessNoteKey(loginId, weekStartIso);
    const note = state.weeklyBusinessNotes[key];
    refs.personalBusinessNoteSection.classList.remove("hidden");
    refs.businessNoteInput.value = note?.text || "";
    if (refs.businessNoteMeta) {
      refs.businessNoteMeta.textContent = note?.updatedAt
        ? `最終更新: ${formatDateTimeLabel(note.updatedAt)} / 保存すると全体ページへ即時反映されます。`
        : "保存すると全体ページへ即時反映されます。";
    }
  }

  if (isOverallPage && refs.overallBusinessNoteSection && refs.overallBusinessNoteList) {
    const visibleNotes = [];
    for (const account of state.staffAccounts) {
      const loginId = normalizeLoginId(account.id);
      if (!loginId) {
        continue;
      }
      const key = getWeeklyBusinessNoteKey(loginId, weekStartIso);
      const note = state.weeklyBusinessNotes[key];
      const text = String(note?.text || "").trim();
      if (!text) {
        continue;
      }
      visibleNotes.push({ account, note, text });
    }

    if (visibleNotes.length === 0) {
      refs.overallBusinessNoteSection.classList.add("hidden");
      refs.overallBusinessNoteList.innerHTML = "";
      return;
    }

    refs.overallBusinessNoteSection.classList.remove("hidden");
    const lines = [];

    for (const { account, note, text } of visibleNotes) {

      lines.push(`
        <li class="business-note-item">
          <div class="business-note-name">${escapeHtml(account.name)}</div>
          <div class="business-note-text">${escapeHtml(text)}</div>
          <div class="request-item-meta">${note?.updatedAt ? `最終更新: ${escapeHtml(formatDateTimeLabel(note.updatedAt))}` : ""}</div>
        </li>
      `);
    }

    refs.overallBusinessNoteList.innerHTML = lines.join("");
  }
}

function getWeeklyBusinessNoteKey(loginId, weekStartIso) {
  return `${normalizeLoginId(loginId)}::${weekStartIso}`;
}

function startCloudListener() {
  if (!cloudSyncEnabled || !currentFirebaseUser || cloudUnsubscribe) {
    return;
  }

  cloudUnsubscribe = firestoreDb.collection(FIRESTORE_COLLECTION).doc(FIRESTORE_DOCUMENT).onSnapshot(
    async (snapshot) => {
      if (!snapshot.exists) {
        return;
      }

      const cloudData = snapshot.data();
      const mergedCloudData = mergeCloudDataWithPersonalDraft(cloudData);
      const remoteUpdatedAt = normalizeTimestamp(cloudData.updatedAt);
      if (!remoteUpdatedAt) {
        return;
      }

      if (!lastKnownRemoteUpdatedAt) {
        lastKnownRemoteUpdatedAt = remoteUpdatedAt;
        applyLoadedData(mergedCloudData, false);
        localStorage.setItem(STORAGE_KEY, JSON.stringify(buildLocalPayload()));
        await render();

        // 初回同期でも自分宛の承認待ち依頼があれば通知する
        if (getPendingIncomingRequests(cloudData.confirmationRequests).length > 0) {
          notifyRemoteUpdate(cloudData);
        }
        return;
      }

      if (remoteUpdatedAt === lastKnownRemoteUpdatedAt) {
        return;
      }

      lastKnownRemoteUpdatedAt = remoteUpdatedAt;
      applyLoadedData(mergedCloudData, false);
      localStorage.setItem(STORAGE_KEY, JSON.stringify(buildLocalPayload()));
      await render();

      if (remoteUpdatedAt !== lastLocalSaveUpdatedAt && !isOwnCloudUpdate(cloudData)) {
        notifyRemoteUpdate(cloudData);
      }
    },
    () => {
      setNotice("Firestore監視に失敗しました。再読み込みしてください。");
    },
  );
}

function renderWeekLabel(weekDates) {
  if (!refs.weekLabel) {
    return;
  }
  const start = weekDates[0];
  const end = weekDates[6];
  refs.weekLabel.textContent = `${formatDateJP(start)} 〜 ${formatDateJP(end)}`;
}

function renderTable(weekDates) {
  if (!refs.scheduleTable) {
    return;
  }

  const thead = document.createElement("thead");
  const trHead = document.createElement("tr");

  const thName = document.createElement("th");
  thName.textContent = "名前（ID）";
  thName.classList.add("name-col");
  trHead.appendChild(thName);

  for (const date of weekDates) {
    const th = document.createElement("th");
    const dateStr = toISODate(date);
    const holidayName = getHolidayName(dateStr);

    const day = document.createElement("span");
    day.className = "day-label";
    day.textContent = `${date.getMonth() + 1}/${date.getDate()}（${WEEKDAY_LABELS[date.getDay()]}）`;
    th.appendChild(day);

    if (holidayName) {
      const chip = document.createElement("span");
      chip.className = "day-holiday";
      chip.textContent = holidayName;
      th.appendChild(chip);
    }

    trHead.appendChild(th);
  }

  thead.appendChild(trHead);

  const tbody = document.createElement("tbody");
  const personalRowName = getPersonalRowName();
  const visibleStaff = isPersonalPage
    ? personalRowName
      ? [personalRowName]
      : []
    : state.staff;

  for (const name of visibleStaff) {
    const tr = document.createElement("tr");

    const tdName = document.createElement("th");
    tdName.textContent = name;
    tr.appendChild(tdName);

    for (const date of weekDates) {
      const dateStr = toISODate(date);
      const entry = resolveEntry(name, dateStr);
      const td = document.createElement("td");
      const btn = document.createElement("button");
      const isEditable = canEditRow(name);
      const statusClass = getStatusClass(entry);

      btn.type = "button";
      btn.className = `cell-btn ${entry ? entry.source : ""} ${statusClass} ${isEditable ? "" : "readonly"}`.trim();
      btn.innerHTML = renderCellHtml(entry);

      if (isEditable) {
        btn.addEventListener("click", () => openEditDialog(name, dateStr, entry));
      } else {
        btn.disabled = true;
        btn.title = state.isAdmin
          ? "管理者または本人のみ編集できます"
          : "個人入力ページで本人ログイン時のみ編集できます";
      }

      td.appendChild(btn);
      tr.appendChild(td);
    }

    tbody.appendChild(tr);
  }

  if (isPersonalPage && visibleStaff.length === 0) {
    const tr = document.createElement("tr");
    const td = document.createElement("td");
    td.colSpan = weekDates.length + 1;
    td.textContent = "ログインすると自分の予定だけ表示されます。";
    td.style.textAlign = "center";
    td.style.padding = "14px";
    tr.appendChild(td);
    tbody.appendChild(tr);
  }

  refs.scheduleTable.innerHTML = "";
  refs.scheduleTable.appendChild(thead);
  refs.scheduleTable.appendChild(tbody);
  syncTableScrollbar();
}

function renderMonthlyCalendar() {
  if (!refs.monthlyScheduleTable || !refs.monthLabel) {
    return;
  }
  if (!isPersonalPage && !isOverallPage) {
    return;
  }

  const monthStart = getMonthStart(state.currentMonthStart || new Date());
  state.currentMonthStart = monthStart;
  refs.monthLabel.textContent = `${monthStart.getFullYear()}年${monthStart.getMonth() + 1}月`;

  const targetName = isPersonalPage ? getLoggedInScheduleTargetName() : "";
  if (isPersonalPage && !targetName) {
    refs.monthlyScheduleTable.innerHTML = "<tbody><tr><td class=\"monthly-empty\">ログイン中ユーザーの予定表示対象が見つかりません。</td></tr></tbody>";
    return;
  }

  const weekDays = ["日", "月", "火", "水", "木", "金", "土"];
  const thead = document.createElement("thead");
  const trHead = document.createElement("tr");
  for (const wd of weekDays) {
    const th = document.createElement("th");
    th.textContent = wd;
    trHead.appendChild(th);
  }
  thead.appendChild(trHead);

  const tbody = document.createElement("tbody");
  const firstVisible = addDays(monthStart, -monthStart.getDay());
  for (let row = 0; row < 6; row += 1) {
    const tr = document.createElement("tr");
    for (let col = 0; col < 7; col += 1) {
      const date = addDays(firstVisible, row * 7 + col);
      const dateStr = toISODate(date);
      const td = document.createElement("td");
      const inCurrentMonth = date.getMonth() === monthStart.getMonth();
      if (!inCurrentMonth) {
        td.classList.add("monthly-muted");
      }
      if (date.getDay() === 0) {
        td.classList.add("monthly-sunday");
      }

      const dayNo = document.createElement("div");
      dayNo.className = "monthly-day-no";
      dayNo.textContent = String(date.getDate());

      td.appendChild(dayNo);

      if (isOverallPage) {
        td.classList.add("monthly-overall-cell");
        const listEl = document.createElement("div");
        listEl.className = "monthly-entry-list";

        let hasAnyEntry = false;
        for (const name of state.staff) {
          const entry = resolveEntry(name, dateStr);
          if (!entry) {
            continue;
          }
          hasAnyEntry = true;
          const lineEl = document.createElement("div");
          lineEl.className = "monthly-entry-line";
          lineEl.textContent = `${name}: ${buildMonthlyEntryText(entry)}`;
          listEl.appendChild(lineEl);
        }

        if (!hasAnyEntry) {
          const emptyEl = document.createElement("div");
          emptyEl.className = "monthly-empty";
          emptyEl.textContent = "-";
          listEl.appendChild(emptyEl);
        }

        td.appendChild(listEl);
      } else {
        const entryEl = document.createElement("div");
        entryEl.className = "monthly-entry";
        const entry = resolveEntry(targetName, dateStr);
        entryEl.textContent = entry ? buildMonthlyEntryText(entry) : "-";
        td.appendChild(entryEl);
      }

      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }

  refs.monthlyScheduleTable.innerHTML = "";
  refs.monthlyScheduleTable.appendChild(thead);
  refs.monthlyScheduleTable.appendChild(tbody);
}

function buildMonthlyEntryText(entry) {
  const parts = [formatEntryStatusText(entry)];
  const work = formatEntryWorkText(entry);
  if (work) {
    parts.push(work);
  }
  return parts.filter((v) => Boolean(v)).join(" / ");
}

function getLoggedInScheduleTargetName() {
  const loginId = normalizeLoginId(state.currentUserId);
  if (loginId) {
    const account = findAccountByLoginId(loginId);
    if (account?.name) {
      return account.name;
    }
  }
  if (isPersonalPage) {
    return getPersonalRowName();
  }
  return "";
}

function bindTableScrollbarSync() {
  if (!refs.scheduleTable || !refs.scheduleScrollbar) {
    return;
  }

  const wrap = refs.scheduleTable.closest(".table-wrap");
  if (!wrap) {
    return;
  }

  if (wrap.dataset.scrollSyncBound !== "1") {
    wrap.dataset.scrollSyncBound = "1";
    wrap.addEventListener("scroll", () => {
      if (!refs.scheduleScrollbar || tableScrollbarSyncing) {
        return;
      }
      tableScrollbarSyncing = true;
      refs.scheduleScrollbar.scrollLeft = wrap.scrollLeft;
      tableScrollbarSyncing = false;
    });
  }

  if (refs.scheduleScrollbar.dataset.scrollSyncBound !== "1") {
    refs.scheduleScrollbar.dataset.scrollSyncBound = "1";
    refs.scheduleScrollbar.addEventListener("scroll", () => {
      if (tableScrollbarSyncing) {
        return;
      }
      tableScrollbarSyncing = true;
      wrap.scrollLeft = refs.scheduleScrollbar.scrollLeft;
      tableScrollbarSyncing = false;
    });
  }

  if (!tableScrollbarResizeBound) {
    tableScrollbarResizeBound = true;
    window.addEventListener("resize", () => {
      syncTableScrollbar();
    });
  }
}

function syncTableScrollbar() {
  if (!refs.scheduleTable || !refs.scheduleScrollbar || !refs.scheduleScrollbarInner) {
    return;
  }

  const wrap = refs.scheduleTable.closest(".table-wrap");
  if (!wrap) {
    return;
  }

  const contentWidth = Math.ceil(refs.scheduleTable.scrollWidth);
  const viewportWidth = Math.ceil(wrap.clientWidth);

  if (contentWidth <= viewportWidth + 1) {
    refs.scheduleScrollbar.classList.add("hidden");
    refs.scheduleScrollbar.scrollLeft = 0;
    refs.scheduleScrollbarInner.style.width = "1px";
    return;
  }

  refs.scheduleScrollbar.classList.remove("hidden");
  refs.scheduleScrollbarInner.style.width = `${contentWidth}px`;
  refs.scheduleScrollbar.scrollLeft = wrap.scrollLeft;
}

function renderCellHtml(entry) {
  if (!entry) {
    return `<div class="cell-status">-</div><div class="cell-work">未入力</div>`;
  }

  const statusText = formatEntryStatusText(entry);
  const work = formatEntryWorkText(entry);
  const place = formatEntryPlaceText(entry);

  return `
    <div class="cell-status">${escapeHtml(statusText)}</div>
    <div class="cell-work">${escapeHtml(work)}</div>
    <div class="cell-place">${escapeHtml(place)}</div>
  `;
}

function renderUserOrderList() {
  if (!refs.userOrderList || isPersonalPage || !state.isAdmin) {
    if (refs.userOrderList) {
      refs.userOrderList.innerHTML = "";
    }
    return;
  }

  refs.userOrderList.innerHTML = "";

  state.staffAccounts.forEach((account, index) => {
    const li = document.createElement("li");
    li.className = "user-order-item";
    li.draggable = true;
    li.dataset.index = String(index);

    const handle = document.createElement("span");
    handle.className = "drag-handle";
    handle.textContent = "⠿";
    handle.title = "ドラッグして並び替え";
    handle.setAttribute("aria-hidden", "true");

    const meta = document.createElement("div");
    meta.className = "user-order-meta";
    meta.innerHTML = `
      <strong>${escapeHtml(account.name)}</strong>
      <span>（ID: ${escapeHtml(account.id)}）</span>
      <span class="password-mask">認証: Firebase</span>
    `;

    const buttons = document.createElement("div");
    buttons.className = "order-buttons";

    const upBtn = document.createElement("button");
    upBtn.type = "button";
    upBtn.className = "btn btn-secondary order-btn";
    upBtn.textContent = "↑";
    upBtn.dataset.action = "up";
    upBtn.dataset.index = String(index);
    upBtn.disabled = index === 0;

    const downBtn = document.createElement("button");
    downBtn.type = "button";
    downBtn.className = "btn btn-secondary order-btn";
    downBtn.textContent = "↓";
    downBtn.dataset.action = "down";
    downBtn.dataset.index = String(index);
    downBtn.disabled = index === state.staffAccounts.length - 1;

    const deleteBtn = document.createElement("button");
    deleteBtn.type = "button";
    deleteBtn.className = "btn btn-ghost order-btn order-btn-danger";
    deleteBtn.textContent = "削除";
    deleteBtn.dataset.action = "delete";
    deleteBtn.dataset.index = String(index);

    const editNameBtn = document.createElement("button");
    editNameBtn.type = "button";
    editNameBtn.className = "btn btn-secondary order-btn";
    editNameBtn.textContent = "名前変更";
    editNameBtn.dataset.action = "edit-name";
    editNameBtn.dataset.index = String(index);

    buttons.appendChild(editNameBtn);
    buttons.appendChild(upBtn);
    buttons.appendChild(downBtn);
    buttons.appendChild(deleteBtn);
    li.appendChild(handle);
    li.appendChild(meta);
    li.appendChild(buttons);
    refs.userOrderList.appendChild(li);
  });

  bindDragAndDrop(refs.userOrderList);
}

function renderPasswordChangeUserOptions() {
  if (!refs.changePasswordUserSelect) {
    return;
  }

  if (!state.isAdmin) {
    refs.changePasswordUserSelect.innerHTML = '<option value="">選択してください</option>';
    return;
  }

  const currentValue = normalizeLoginId(refs.changePasswordUserSelect.value);
  const options = state.staffAccounts
    .filter((account) => {
      const accountId = normalizeLoginId(account.id);
      return Boolean(accountId) && !isAdminLoginId(accountId);
    })
    .map((account) => `<option value="${escapeHtml(account.id)}">${escapeHtml(account.name)}（${escapeHtml(account.id)}）</option>`)
    .join("");

  refs.changePasswordUserSelect.innerHTML = `<option value="">選択してください</option>${options}`;

  if (currentValue) {
    const exists = Array.from(refs.changePasswordUserSelect.options)
      .some((option) => normalizeLoginId(option.value) === currentValue);
    if (exists) {
      refs.changePasswordUserSelect.value = currentValue;
    }
  }
}

function syncRequestFormUi() {
  const enabled = Boolean(refs.requestConfirmEnabled?.checked);
  if (refs.requestTargetInput) {
    refs.requestTargetInput.disabled = !enabled;
  }
  if (refs.requestMessageInput) {
    refs.requestMessageInput.disabled = !enabled;
  }
}

function isMorningOffStatus(status) {
  return status === "午前休" || status === "午前有休";
}

function isAfternoonOffStatus(status) {
  return status === "午後休" || status === "午後有休";
}

function getHalfDayWorkingSlot(status) {
  if (isMorningOffStatus(status)) {
    return "午後";
  }
  if (isAfternoonOffStatus(status)) {
    return "午前";
  }
  return "";
}

function syncHalfDayInputUi(status) {
  const slot = getHalfDayWorkingSlot(status);
  const isHalfDayMode = Boolean(slot);
  const workLabel = slot ? `${slot}の業務内容` : "業務内容";
  const placeLabel = slot ? `${slot}の場所` : "場所";

  if (refs.workInputLabel) {
    refs.workInputLabel.textContent = workLabel;
    refs.workInputLabel.classList.toggle("halfday-highlight-label", isHalfDayMode);
  }
  if (refs.placeInputLabel) {
    refs.placeInputLabel.textContent = placeLabel;
    refs.placeInputLabel.classList.toggle("halfday-highlight-label", isHalfDayMode);
  }
  if (refs.workInput) {
    refs.workInput.placeholder = slot ? `例: ${slot}の作業内容` : "例: 官場線 作業準備";
    refs.workInput.classList.toggle("halfday-highlight-input", isHalfDayMode);
  }
  if (refs.placeInput) {
    refs.placeInput.placeholder = slot ? `例: ${slot}の訪問先` : "例: 鹿児島市";
    refs.placeInput.classList.toggle("halfday-highlight-input", isHalfDayMode);
  }
  if (refs.halfDayWorkHint) {
    refs.halfDayWorkHint.classList.toggle("halfday-highlight-hint", isHalfDayMode);
    if (slot) {
      refs.halfDayWorkHint.textContent = `${status}が選択されています。${slot}の業務を入力してください。`;
      refs.halfDayWorkHint.classList.remove("hidden");
    } else {
      refs.halfDayWorkHint.classList.add("hidden");
      refs.halfDayWorkHint.textContent = "";
    }
  }
}

function syncHalfDaySecondaryStatusUi(status) {
  if (!refs.secondaryStatusRow || !refs.secondaryStatusInput) {
    return;
  }

  const slot = getHalfDayWorkingSlot(status);
  if (!slot) {
    refs.secondaryStatusRow.classList.add("hidden");
    refs.secondaryStatusInput.value = "";
    return;
  }

  if (refs.secondaryStatusLabel) {
    refs.secondaryStatusLabel.textContent = `${slot}の状態`;
  }

  refs.secondaryStatusRow.classList.remove("hidden");
}

function formatEntryStatusText(entry) {
  const status = String(entry?.status || "").trim();
  if (!status) {
    return "";
  }

  const slot = getHalfDayWorkingSlot(status);
  const secondaryStatus = String(entry?.secondaryStatus || "").trim();
  if (slot && secondaryStatus) {
    return `${status} / ${slot}:${secondaryStatus}`;
  }

  return status;
}

function formatEntryWorkText(entry) {
  const work = String(entry?.work || "").trim();
  if (!work) {
    return "";
  }

  const slot = getHalfDayWorkingSlot(entry?.status || "");
  return slot ? `${slot}業務: ${work}` : work;
}

function formatEntryPlaceText(entry) {
  const place = String(entry?.place || "").trim();
  if (!place) {
    return "";
  }

  const slot = getHalfDayWorkingSlot(entry?.status || "");
  return slot ? `${slot}場所: ${place}` : place;
}

function populateRequestTargetOptions(ownerName) {
  if (!refs.requestTargetInput) {
    return;
  }

  const requesterId = normalizeLoginId(state.currentUserId);
  refs.requestTargetInput.innerHTML = '<option value="">選択してください</option>';

  state.staffAccounts
    .filter((account) => normalizeLoginId(account.id) !== requesterId && account.name !== ownerName)
    .forEach((account) => {
      const option = document.createElement("option");
      option.value = account.id;
      option.textContent = account.name;
      refs.requestTargetInput.appendChild(option);
    });
}

function renderRequestInbox() {
  if (!refs.requestInboxSection || !refs.requestInboxList) {
    return;
  }

  const incoming = getPendingIncomingRequests(state.confirmationRequests);
  const outgoing = getPendingOutgoingRequests(state.confirmationRequests);

  if (incoming.length === 0 && outgoing.length === 0) {
    refs.requestInboxSection.classList.add("hidden");
    refs.requestInboxList.innerHTML = "";
    return;
  }

  refs.requestInboxSection.classList.remove("hidden");
  const lines = [];

  for (const request of incoming) {
    lines.push(`
      <li class="request-item">
        <div class="request-item-title">受信: ${escapeHtml(request.requesterName)} さんから確認依頼</div>
        <div class="request-item-meta">対象: ${escapeHtml(request.ownerName)} / ${escapeHtml(request.startDate)} / ${request.repeatDays}日分</div>
        <div class="request-item-meta">送信日時: ${escapeHtml(formatDateTimeLabel(request.createdAt))}</div>
        <div class="request-item-meta">内容: ${escapeHtml(formatEntryStatusText(request.entryData))}${request.entryData?.work ? ` / ${escapeHtml(request.entryData.work)}` : ""}${request.entryData?.place ? ` / ${escapeHtml(request.entryData.place)}` : ""}</div>
        ${request.message ? `<div class="request-item-meta">メモ: ${escapeHtml(request.message)}</div>` : ""}
        <div class="request-item-buttons">
          <button class="btn" type="button" data-request-action="approve" data-request-id="${escapeHtml(request.id)}">承認して反映</button>
          <button class="btn btn-secondary" type="button" data-request-action="reject" data-request-id="${escapeHtml(request.id)}">却下</button>
        </div>
      </li>
    `);
  }

  for (const request of outgoing) {
    lines.push(`
      <li class="request-item">
        <div class="request-item-title">送信: ${escapeHtml(request.targetName)} さんへ確認依頼中</div>
        <div class="request-item-meta">対象: ${escapeHtml(request.ownerName)} / ${escapeHtml(request.startDate)} / ${request.repeatDays}日分</div>
        <div class="request-item-meta">送信日時: ${escapeHtml(formatDateTimeLabel(request.createdAt))}</div>
        ${request.message ? `<div class="request-item-meta">メモ: ${escapeHtml(request.message)}</div>` : ""}
        <div class="request-item-buttons">
          <button class="btn btn-ghost" type="button" data-request-action="cancel" data-request-id="${escapeHtml(request.id)}">依頼を取消</button>
        </div>
      </li>
    `);
  }

  refs.requestInboxList.innerHTML = lines.join("");
}

function ensureDesktopRequestPanel() {
  if (desktopRequestPanelEl || typeof document === "undefined") {
    return;
  }

  const panel = document.createElement("section");
  panel.id = "desktopRequestPanel";
  panel.className = "desktop-request-panel hidden";
  panel.setAttribute("aria-live", "polite");
  panel.innerHTML = `
    <div class="desktop-request-panel-title">確認依頼（承認待ち）</div>
    <ul id="desktopRequestList" class="desktop-request-list"></ul>
  `;

  document.body.appendChild(panel);
  desktopRequestPanelEl = panel;
  desktopRequestListEl = panel.querySelector("#desktopRequestList");

  if (desktopRequestListEl) {
    desktopRequestListEl.addEventListener("click", async (event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) {
        return;
      }

      const button = target.closest("button[data-request-action]");
      if (!button) {
        return;
      }

      const action = button.dataset.requestAction;
      const requestId = String(button.dataset.requestId || "");
      if (!action || !requestId) {
        return;
      }

      await handleConfirmationRequestAction(requestId, action);
    });
  }
}

function renderDesktopRequestPanel() {
  if (!desktopRequestPanelEl || !desktopRequestListEl) {
    return;
  }

  // PC画面のみ常駐表示（モバイルは既存セクションで対応）
  if (window.innerWidth < 900 || !currentFirebaseUser) {
    desktopRequestPanelEl.classList.add("hidden");
    desktopRequestListEl.innerHTML = "";
    return;
  }

  const incoming = getPendingIncomingRequests(state.confirmationRequests);
  if (incoming.length === 0) {
    desktopRequestPanelEl.classList.add("hidden");
    desktopRequestListEl.innerHTML = "";
    return;
  }

  desktopRequestPanelEl.classList.remove("hidden");
  desktopRequestListEl.innerHTML = incoming.map((request) => `
    <li class="desktop-request-item">
      <div class="desktop-request-item-title">${escapeHtml(request.requesterName)} さんから確認依頼</div>
      <div class="desktop-request-item-meta">${escapeHtml(request.ownerName)} / ${escapeHtml(request.startDate)} / ${request.repeatDays}日分</div>
      <div class="desktop-request-item-meta">送信日時: ${escapeHtml(formatDateTimeLabel(request.createdAt))}</div>
      <div class="desktop-request-item-actions">
        <button class="btn" type="button" data-request-action="approve" data-request-id="${escapeHtml(request.id)}">承認</button>
        <button class="btn btn-secondary" type="button" data-request-action="reject" data-request-id="${escapeHtml(request.id)}">却下</button>
      </div>
    </li>
  `).join("");
}

function getPendingIncomingRequests(requests) {
  const currentId = normalizeLoginId(state.currentUserId);
  if (!currentId || !Array.isArray(requests)) {
    return [];
  }
  return requests.filter((item) => item && item.status === "pending" && normalizeLoginId(item.targetId) === currentId);
}

function getPendingOutgoingRequests(requests) {
  const currentId = normalizeLoginId(state.currentUserId);
  if (!currentId || !Array.isArray(requests)) {
    return [];
  }
  return requests.filter((item) => item && item.status === "pending" && normalizeLoginId(item.requesterId) === currentId);
}

async function handleConfirmationRequestAction(requestId, action) {
  const request = state.confirmationRequests.find((item) => item && item.id === requestId);
  if (!request || request.status !== "pending") {
    return;
  }

  const currentId = normalizeLoginId(state.currentUserId);
  if (!currentId) {
    return;
  }

  if (action === "approve") {
    if (normalizeLoginId(request.targetId) !== currentId) {
      setNotice("この依頼は承認できません。");
      return;
    }
    const repeatDays = Number(request.repeatDays || 1);
    clearManualEntriesWithRepeat(request.ownerName, request.startDate, repeatDays);
    const savedCount = saveManualEntriesWithRepeat(
      request.ownerName,
      request.startDate,
      {
        ...request.entryData,
        source: "manual",
        updatedAt: new Date().toISOString(),
      },
      repeatDays,
    );
    removeConfirmationRequest(requestId);
    saveState({ forceCloud: true });
    setNotice(`${request.requesterName} さんの依頼を承認し、${savedCount}件を反映しました。`);
    await render();
    return;
  }

  if (action === "reject") {
    if (normalizeLoginId(request.targetId) !== currentId) {
      setNotice("この依頼は却下できません。");
      return;
    }
    removeConfirmationRequest(requestId);
    saveState({ forceCloud: true });
    setNotice(`${request.requesterName} さんの依頼を却下しました。`);
    await render();
    return;
  }

  if (action === "cancel") {
    if (normalizeLoginId(request.requesterId) !== currentId) {
      setNotice("この依頼は取消できません。");
      return;
    }
    removeConfirmationRequest(requestId);
    saveState({ forceCloud: true });
    setNotice("確認依頼を取り消しました。");
    await render();
  }
}

function removeConfirmationRequest(requestId) {
  state.confirmationRequests = state.confirmationRequests.filter((item) => item && item.id !== requestId);
}

function trimResolvedRequests() {
  const pending = state.confirmationRequests.filter((item) => item && item.status === "pending");
  const resolved = state.confirmationRequests
    .filter((item) => item && item.status !== "pending")
    .sort((a, b) => String(b.resolvedAt || "").localeCompare(String(a.resolvedAt || "")))
    .slice(0, 120);

  state.confirmationRequests = [...pending, ...resolved];
}

function createRequestId() {
  if (window.crypto && typeof window.crypto.randomUUID === "function") {
    return window.crypto.randomUUID();
  }
  return `req-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function markScheduleNeedsFinalize() {
  scheduleFinalizeRequired = true;
  syncFinalizeButtonUi();
}

function syncFinalizeButtonUi() {
  if (!refs.finalizeScheduleBtn) {
    return;
  }

  if (finalizeInFlight) {
    refs.finalizeScheduleBtn.disabled = true;
    refs.finalizeScheduleBtn.textContent = "確定通知中...";
    return;
  }

  if (scheduleFinalizeRequired) {
    refs.finalizeScheduleBtn.disabled = false;
    refs.finalizeScheduleBtn.textContent = "入力を確定して通知";
    return;
  }

  refs.finalizeScheduleBtn.disabled = true;
  refs.finalizeScheduleBtn.textContent = "確定済み（変更後に有効）";
}

function bindDragAndDrop(list) {
  if (list.dataset.dndBound === "1") {
    return;
  }
  list.dataset.dndBound = "1";

  let dragSrcIndex = null;
  let dragOverItem = null;

  list.addEventListener("dragstart", (event) => {
    const li = event.target.closest("li[data-index]");
    if (!li) {
      return;
    }
    dragSrcIndex = Number(li.dataset.index);
    li.classList.add("dragging");
    event.dataTransfer.effectAllowed = "move";
  });

  list.addEventListener("dragend", () => {
    list.querySelectorAll(".dragging, .drag-over").forEach((el) => {
      el.classList.remove("dragging", "drag-over");
    });
    dragSrcIndex = null;
    dragOverItem = null;
  });

  list.addEventListener("dragover", (event) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    const li = event.target.closest("li[data-index]");
    if (!li || li === dragOverItem) {
      return;
    }
    list.querySelectorAll(".drag-over").forEach((el) => el.classList.remove("drag-over"));
    dragOverItem = li;
    li.classList.add("drag-over");
  });

  list.addEventListener("drop", async (event) => {
    event.preventDefault();
    const li = event.target.closest("li[data-index]");
    if (!li || dragSrcIndex === null) {
      return;
    }

    const dropIndex = Number(li.dataset.index);
    if (dragSrcIndex === dropIndex) {
      return;
    }

    const items = state.staffAccounts;
    const [moved] = items.splice(dragSrcIndex, 1);
    items.splice(dropIndex, 0, moved);

    refreshStaffFromAccounts();
    saveState();
    setNotice("表示順を更新しました。");
    await render();
  });
}

function moveStaffAccount(index, delta) {
  const nextIndex = index + delta;
  if (index < 0 || nextIndex < 0 || index >= state.staffAccounts.length || nextIndex >= state.staffAccounts.length) {
    return false;
  }

  const items = state.staffAccounts;
  [items[index], items[nextIndex]] = [items[nextIndex], items[index]];
  return true;
}

function deleteManualEntriesByUserName(userName) {
  const prefix = `${userName}::`;
  for (const key of Object.keys(state.manualEntries)) {
    if (key.startsWith(prefix)) {
      delete state.manualEntries[key];
    }
  }
}

function renameManualEntriesByUserName(previousName, nextName) {
  if (!previousName || !nextName || previousName === nextName) {
    return;
  }

  const prevPrefix = `${previousName}::`;
  for (const key of Object.keys(state.manualEntries)) {
    if (!key.startsWith(prevPrefix)) {
      continue;
    }

    const dateStr = key.slice(prevPrefix.length);
    const nextKey = `${nextName}::${dateStr}`;
    state.manualEntries[nextKey] = state.manualEntries[key];
    delete state.manualEntries[key];
  }
}

function getStatusClass(entry) {
  if (!entry || entry.source !== "manual") {
    return "";
  }

  switch (entry.status) {
    case "現場":
      return "status-genba";
    case "内業":
      return "status-naigyo";
    case "打合せ":
      return "status-meeting";
    case "移動":
      return "status-move";
    case "休み":
    case "午前休":
    case "午後休":
      return "status-off";
    case "有給":
    case "午前有休":
    case "午後有休":
      return "status-paid";
    default:
      return "";
  }
}

function resolveEntry(name, dateStr) {
  const manual = state.manualEntries[entryKey(name, dateStr)];
  if (manual) {
    return manual;
  }

  const date = fromISODate(dateStr);

  if (state.settings.holidayAutoEnabled) {
    const holidayName = getHolidayName(dateStr);
    if (holidayName) {
      return {
        status: "休み",
        work: `（祝日）${holidayName}`,
        place: "",
        source: "holiday",
      };
    }
  }

  if (date.getDay() === 0) {
    return {
      status: "休み",
      work: "（日曜休み）",
      place: "",
      source: "sunday",
    };
  }

  if (isCompanyHoliday(date)) {
    return {
      status: "休み",
      work: "（土曜休日）",
      place: "",
      source: "company",
    };
  }

  return null;
}

function openEditDialog(name, dateStr, currentEntry) {
  if (!canEditRow(name) || !refs.editDialog) {
    setNotice("本人の行、または管理者として編集できます。");
    return;
  }

  state.editTarget = { name, date: dateStr };

  const date = fromISODate(dateStr);
  if (refs.editMeta) {
    refs.editMeta.textContent = `${name} / ${formatDateJP(date)}`;
  }

  if (refs.statusInput) {
    refs.statusInput.innerHTML = STATUS_OPTIONS.map((s) => `<option value="${s}">${s}</option>`).join("");
    refs.statusInput.value = currentEntry?.status || "現場";
  }
  if (refs.secondaryStatusInput) {
    const options = HALF_DAY_SECONDARY_STATUS_OPTIONS
      .map((s) => `<option value="${s}">${s}</option>`)
      .join("");
    refs.secondaryStatusInput.innerHTML = `<option value="">選択してください</option>${options}`;
    refs.secondaryStatusInput.value = currentEntry?.secondaryStatus || "";
  }
  if (refs.workInput) {
    refs.workInput.value = currentEntry?.work || "";
  }
  if (refs.placeInput) {
    refs.placeInput.value = currentEntry?.place || "";
  }
  const status = currentEntry?.status || "現場";
  syncHalfDayInputUi(status);
  syncHalfDaySecondaryStatusUi(status);
  if (refs.repeatEnabled) {
    refs.repeatEnabled.checked = false;
  }
  if (refs.repeatCount) {
    refs.repeatCount.value = "1";
  }

  populateRequestTargetOptions(name);
  if (refs.requestConfirmEnabled) {
    refs.requestConfirmEnabled.checked = false;
  }
  if (refs.requestTargetInput) {
    refs.requestTargetInput.value = "";
  }
  if (refs.requestMessageInput) {
    refs.requestMessageInput.value = "";
  }
  syncRequestFormUi();

  openDialog(refs.editDialog);
}

function saveManualEntriesWithRepeat(name, startDateStr, entryData, repeatDays) {
  const count = clamp(repeatDays, 1, 12);
  const startDate = fromISODate(startDateStr);

  for (let i = 0; i < count; i += 1) {
    const targetDate = addDays(startDate, i);
    const key = entryKey(name, toISODate(targetDate));
    state.manualEntries[key] = {
      ...entryData,
      updatedAt: new Date().toISOString(),
    };
  }

  markScheduleNeedsFinalize();

  return count;
}

function clearManualEntriesWithRepeat(name, startDateStr, repeatDays) {
  const count = clamp(repeatDays, 1, 12);
  const startDate = fromISODate(startDateStr);

  for (let i = 0; i < count; i += 1) {
    const targetDate = addDays(startDate, i);
    const key = entryKey(name, toISODate(targetDate));
    delete state.manualEntries[key];
  }
}

function isCompanyHoliday(date) {
  if (date.getDay() !== 6) {
    return false;
  }

  const month = date.getMonth() + 1;

  if (monthInRange(month, state.settings.dullStartMonth, state.settings.dullEndMonth)) {
    return true;
  }

  if (monthInRange(month, state.settings.busyStartMonth, state.settings.busyEndMonth)) {
    const saturdayNo = getSaturdayNoInMonth(date);
    if (state.settings.biweeklyPattern === "1-3") {
      return saturdayNo === 1 || saturdayNo === 3;
    }
    return saturdayNo === 2 || saturdayNo === 4;
  }

  return false;
}

function monthInRange(month, start, end) {
  if (start <= end) {
    return month >= start && month <= end;
  }
  return month >= start || month <= end;
}

function getSaturdayNoInMonth(date) {
  const day = date.getDate();
  return Math.floor((day - 1) / 7) + 1;
}

async function ensureHolidayCache(weekDates) {
  if (!state.settings.holidayAutoEnabled) {
    return;
  }

  const years = [...new Set(weekDates.map((d) => d.getFullYear()))];
  await Promise.all(years.map((year) => loadHolidayByYear(year)));
}

async function loadHolidayByYear(year) {
  if (state.holidaysByYear[year]) {
    return;
  }

  const url = `https://holidays-jp.github.io/api/v1/${year}/date.json`;
  try {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error("祝日データを取得できませんでした。");
    }
    const data = await response.json();
    state.holidaysByYear[year] = data;
  } catch (error) {
    state.holidaysByYear[year] = {};
    setNotice(`祝日データ取得に失敗: ${year}年`);
  }
}

function getHolidayName(dateStr) {
  const year = Number(dateStr.slice(0, 4));
  return state.holidaysByYear[year]?.[dateStr] || "";
}

function buildMonthOptions() {
  if (!refs.dullStartMonth || !refs.dullEndMonth || !refs.busyStartMonth || !refs.busyEndMonth) {
    return;
  }

  refs.dullStartMonth.innerHTML = "";
  refs.dullEndMonth.innerHTML = "";
  refs.busyStartMonth.innerHTML = "";
  refs.busyEndMonth.innerHTML = "";

  for (let m = 1; m <= 12; m += 1) {
    const appendOption = (target) => {
      const option = document.createElement("option");
      option.value = String(m);
      option.textContent = `${m}月`;
      target.appendChild(option);
    };

    appendOption(refs.dullStartMonth);
    appendOption(refs.dullEndMonth);
    appendOption(refs.busyStartMonth);
    appendOption(refs.busyEndMonth);
  }
}

function syncLoginForm() {
  if (!refs.loginIdInput || !refs.loginPasswordInput) {
    return;
  }
  refs.loginIdInput.value = state.currentUserId || "";
  refs.loginPasswordInput.value = "";
}

function syncAuthUi() {
  if (!refs.currentUserLabel) {
    return;
  }
  const userLabel = state.currentUser || "未ログイン";
  refs.currentUserLabel.textContent = `ログイン: ${userLabel}${state.isAdmin ? " [管理者]" : ""}`;
}

function syncAdminUi() {
  if (!isOverallPage && !isAdminPage) {
    return;
  }

  const showAdmin = Boolean(state.isAdmin);

  if (refs.adminSettingsSection) {
    refs.adminSettingsSection.classList.toggle("hidden", !showAdmin);
  }
  if (refs.adminRegisterSection) {
    refs.adminRegisterSection.classList.toggle("hidden", !showAdmin);
  }
  if (refs.adminOnlyNotice) {
    refs.adminOnlyNotice.classList.toggle("hidden", showAdmin);
  }

  if (!showAdmin && refs.settingsPanel) {
    refs.settingsPanel.classList.add("hidden");
  }
  if (!showAdmin && refs.registerPanel) {
    refs.registerPanel.classList.add("hidden");
  }
}

function canManageAdminSettings() {
  return (!isOverallPage && !isAdminPage) || state.isAdmin;
}

function canEditRow(name) {
  if (!currentFirebaseUser) {
    return false;
  }

  if ((isOverallPage || isAdminPage) && state.isAdmin) {
    return true;
  }

  const personalRowName = getPersonalRowName();
  return isPersonalPage && Boolean(personalRowName) && personalRowName === name;
}

function getPersonalRowName() {
  if (!isPersonalPage) {
    return "";
  }

  const loginId = normalizeLoginId(state.currentUserId);
  if (loginId) {
    const account = findAccountByLoginId(loginId);
    if (account?.name) {
      return account.name;
    }
  }

  if (state.currentUser) {
    return state.currentUser;
  }

  return loginId;
}

function syncSettingsToForm() {
  if (!refs.holidayAutoEnabled) {
    return;
  }

  refs.holidayAutoEnabled.checked = state.settings.holidayAutoEnabled;
  if (refs.dullStartMonth) {
    refs.dullStartMonth.value = String(state.settings.dullStartMonth);
  }
  if (refs.dullEndMonth) {
    refs.dullEndMonth.value = String(state.settings.dullEndMonth);
  }
  if (refs.busyStartMonth) {
    refs.busyStartMonth.value = String(state.settings.busyStartMonth);
  }
  if (refs.busyEndMonth) {
    refs.busyEndMonth.value = String(state.settings.busyEndMonth);
  }
  if (refs.biweeklyPattern) {
    refs.biweeklyPattern.value = state.settings.biweeklyPattern;
  }
}

async function loadState() {
  let localData = null;
  const raw = localStorage.getItem(STORAGE_KEY);
  if (raw) {
    try {
      localData = JSON.parse(raw);
      applyLoadedData(localData, true);
    } catch (error) {
      setNotice("保存データの読み込みに失敗したため初期化しました。");
    }
  }

  if (cloudSyncEnabled && currentFirebaseUser) {
    cloudLoading = true;
    try {
      const snapshot = await firestoreDb.collection(FIRESTORE_COLLECTION).doc(FIRESTORE_DOCUMENT).get();
      if (snapshot.exists) {
        const cloudData = snapshot.data();
        const mergedCloudData = mergeCloudDataWithPersonalDraft(cloudData, localData);
        applyLoadedData(mergedCloudData, false);
        lastKnownRemoteUpdatedAt = normalizeTimestamp(cloudData.updatedAt);
        localStorage.setItem(STORAGE_KEY, JSON.stringify(buildLocalPayload()));
      }
    } catch (error) {
      setNotice("Firestore読込に失敗。ローカルデータで続行します。");
    } finally {
      cloudLoading = false;
    }
  }

  refreshStaffFromAccounts();
  syncCurrentUserFromLoginId();
}

function saveState(options = {}) {
  const announce = options?.announce === true;
  const localOnly = options?.localOnly === true;
  const forceCloud = options?.forceCloud === true;
  const localPayload = buildLocalPayload();
  localStorage.setItem(STORAGE_KEY, JSON.stringify(localPayload));

  if (localOnly && !forceCloud) {
    return;
  }

  const cloudPayload = buildCloudPayload(announce);
  lastLocalSaveUpdatedAt = normalizeTimestamp(cloudPayload.updatedAt);
  queueCloudSave(cloudPayload);
}

function saveWeeklyBusinessNotesImmediately() {
  const localPayload = buildLocalPayload();
  localStorage.setItem(STORAGE_KEY, JSON.stringify(localPayload));

  if (!cloudSyncEnabled || !currentFirebaseUser || !firestoreDb) {
    return;
  }

  const payload = {
    weeklyBusinessNotes: state.weeklyBusinessNotes,
    updatedByName: state.currentUser || (isPersonalPage ? "未ログイン利用者" : "管理画面"),
    updatedById: state.currentUserId || "",
    updatedByPage: pageMode,
    notifyScope: "silent",
    updatedAt: new Date().toISOString(),
  };

  lastLocalSaveUpdatedAt = normalizeTimestamp(payload.updatedAt);

  firestoreDb.collection(FIRESTORE_COLLECTION).doc(FIRESTORE_DOCUMENT)
    .set(payload, { merge: true })
    .then(() => {
      lastKnownRemoteUpdatedAt = normalizeTimestamp(payload.updatedAt);
    })
    .catch(() => {
      setNotice("業務欄の即時反映に失敗しました。再度保存してください。");
    });
}

function buildLocalPayload() {
  return {
    currentWeekStart: toISODate(state.currentWeekStart),
    currentUser: state.currentUser,
    currentUserId: state.currentUserId,
    staff: state.staff,
    staffAccounts: state.staffAccounts,
    manualEntries: state.manualEntries,
    settings: state.settings,
    confirmationRequests: state.confirmationRequests,
    weeklyBusinessNotes: state.weeklyBusinessNotes,
    finalizeRequired: scheduleFinalizeRequired,
  };
}

function buildCloudPayload(announce = false) {
  return {
    currentWeekStart: toISODate(state.currentWeekStart),
    staff: state.staff,
    staffAccounts: state.staffAccounts,
    manualEntries: state.manualEntries,
    settings: state.settings,
    confirmationRequests: state.confirmationRequests,
    weeklyBusinessNotes: state.weeklyBusinessNotes,
    updatedByName: state.currentUser || (isPersonalPage ? "未ログイン利用者" : "管理画面"),
    updatedById: state.currentUserId || "",
    updatedByPage: pageMode,
    notifyScope: announce ? "announce" : "silent",
    updatedAt: new Date().toISOString(),
  };
}

function applyLoadedData(data, restoreSession = true) {
  if (!data || typeof data !== "object") {
    return;
  }
  if (data.staff && Array.isArray(data.staff)) {
    state.staff = data.staff;
  }
  if (data.staffAccounts && Array.isArray(data.staffAccounts)) {
    state.staffAccounts = data.staffAccounts.map((item) => toStaffAccount(item));
  }
  if (data.manualEntries && typeof data.manualEntries === "object") {
    state.manualEntries = data.manualEntries;
  }
  if (data.settings && typeof data.settings === "object") {
    state.settings = {
      ...state.settings,
      ...data.settings,
    };
  }
  if (Array.isArray(data.confirmationRequests)) {
    state.confirmationRequests = data.confirmationRequests;
  }
  if (data.weeklyBusinessNotes && typeof data.weeklyBusinessNotes === "object") {
    state.weeklyBusinessNotes = data.weeklyBusinessNotes;
  }
  if (typeof data.finalizeRequired === "boolean") {
    scheduleFinalizeRequired = data.finalizeRequired;
  }
  if (data.currentWeekStart) {
    state.currentWeekStart = fromISODate(data.currentWeekStart);
  }
  if (restoreSession) {
    if (data.currentUser && typeof data.currentUser === "string") {
      state.currentUser = data.currentUser;
    }
    if (data.currentUserId && typeof data.currentUserId === "string") {
      state.currentUserId = data.currentUserId;
    } else if (state.currentUser) {
      state.currentUserId = findLoginIdByUserName(state.currentUser) || "";
    }
  }
}

function mergeCloudDataWithPersonalDraft(cloudData, draftData = null) {
  if (!isPersonalPage || !scheduleFinalizeRequired || !cloudData || typeof cloudData !== "object") {
    return cloudData;
  }

  const personalName = getPersonalRowName();
  if (!personalName) {
    return cloudData;
  }

  const cloudEntries = cloudData.manualEntries && typeof cloudData.manualEntries === "object"
    ? cloudData.manualEntries
    : {};
  const draftEntriesSource = draftData?.manualEntries && typeof draftData.manualEntries === "object"
    ? draftData.manualEntries
    : state.manualEntries;

  const prefix = `${personalName}::`;
  const mergedEntries = { ...cloudEntries };

  for (const key of Object.keys(mergedEntries)) {
    if (key.startsWith(prefix)) {
      delete mergedEntries[key];
    }
  }

  if (draftEntriesSource && typeof draftEntriesSource === "object") {
    for (const [key, value] of Object.entries(draftEntriesSource)) {
      if (key.startsWith(prefix)) {
        mergedEntries[key] = value;
      }
    }
  }

  return {
    ...cloudData,
    manualEntries: mergedEntries,
    currentWeekStart: draftData?.currentWeekStart || cloudData.currentWeekStart,
  };
}

function queueCloudSave(payload) {
  if (!cloudSyncEnabled || cloudLoading || !currentFirebaseUser) {
    return;
  }

  if (cloudSaveTimer) {
    clearTimeout(cloudSaveTimer);
  }

  cloudSaveTimer = setTimeout(async () => {
    try {
      await firestoreDb.collection(FIRESTORE_COLLECTION).doc(FIRESTORE_DOCUMENT).set(payload, { merge: true });
      lastKnownRemoteUpdatedAt = normalizeTimestamp(payload.updatedAt);
    } catch (error) {
      setNotice("Firestore保存に失敗。再度保存してください。");
    }
  }, 400);
}

function notifyRemoteUpdate(cloudData) {
  const incomingCount = getPendingIncomingRequests(cloudData.confirmationRequests).length;
  if (incomingCount > 0) {
    const msg = `確認依頼が${incomingCount}件あります。確認依頼セクションを確認してください。`;
    showSyncAlert(msg);
    setNotice(msg);
    if (requestNotificationEnabled && window.Notification && Notification.permission === "granted") {
      try {
        new Notification("確認依頼が届きました", {
          body: `承認待ちの依頼が${incomingCount}件あります。`,
        });
      } catch (error) {
        // ブラウザ通知不可時は画面内通知のみ継続
      }
    }
    return;
  }

  if (!scheduleNotificationEnabled) {
    return;
  }

  if (cloudData?.notifyScope === "silent") {
    return;
  }

  const updaterName = String(cloudData.updatedByName || "他の利用者");
  const updatedAt = normalizeTimestamp(cloudData.updatedAt);
  const timeLabel = formatTimeLabel(updatedAt);
  const message = `${updaterName} が予定を更新しました。${timeLabel}`.trim();

  showSyncAlert(message);
  setNotice(message);

  if (window.Notification && Notification.permission === "granted") {
    const body = cloudData.updatedByPage === "overall"
      ? "全体ページの内容が更新されました。"
      : "個人入力ページの内容が更新されました。";
    try {
      new Notification("週間予定表が更新されました", {
        body: `${updaterName} が更新しました。${body}`,
      });
    } catch (error) {
      // ブラウザ通知不可時は画面内通知のみ継続
    }
  }
}

function isOwnCloudUpdate(cloudData) {
  const currentId = normalizeLoginId(state.currentUserId);
  const updaterId = normalizeLoginId(cloudData?.updatedById || "");
  if (currentId && updaterId && currentId === updaterId) {
    return true;
  }

  const currentName = normalizeDisplayName(state.currentUser || "");
  const updaterName = normalizeDisplayName(cloudData?.updatedByName || "");
  return Boolean(currentName && updaterName && currentName === updaterName && cloudData?.updatedByPage === pageMode);
}

function loadNotificationPreferences() {
  try {
    const scheduleRaw = localStorage.getItem(SCHEDULE_NOTIFICATION_PREFERENCE_KEY);
    scheduleNotificationEnabled = scheduleRaw === null ? true : scheduleRaw !== "0";

    const requestRaw = localStorage.getItem(REQUEST_NOTIFICATION_PREFERENCE_KEY);
    requestNotificationEnabled = requestRaw === null ? true : requestRaw !== "0";
  } catch (error) {
    scheduleNotificationEnabled = true;
    requestNotificationEnabled = true;
  }
}

function saveNotificationPreferences() {
  try {
    localStorage.setItem(SCHEDULE_NOTIFICATION_PREFERENCE_KEY, scheduleNotificationEnabled ? "1" : "0");
    localStorage.setItem(REQUEST_NOTIFICATION_PREFERENCE_KEY, requestNotificationEnabled ? "1" : "0");
  } catch (error) {
    // localStorage が使えない環境ではメモリ上の設定のみ使う
  }
}

function setScheduleNotificationEnabled(enabled) {
  scheduleNotificationEnabled = !!enabled;
  saveNotificationPreferences();
  syncNotificationUi();
}

function setRequestNotificationEnabled(enabled) {
  requestNotificationEnabled = !!enabled;
  saveNotificationPreferences();
  syncNotificationUi();
}

function showSyncAlert(text) {
  if (!refs.syncAlert) {
    return;
  }

  refs.syncAlert.textContent = text;
  refs.syncAlert.classList.remove("hidden");

  if (syncAlertTimer) {
    clearTimeout(syncAlertTimer);
  }

  syncAlertTimer = setTimeout(() => {
    refs.syncAlert?.classList.add("hidden");
  }, 7000);
}

function syncNotificationUi() {
  if (!refs.notificationStatus || !refs.enableNotificationsBtn || !refs.toggleScheduleNotificationsBtn || !refs.toggleRequestNotificationsBtn) {
    return;
  }

  if (!("Notification" in window)) {
    refs.notificationStatus.textContent = "端末通知: このブラウザは未対応";
    refs.enableNotificationsBtn.textContent = "通知未対応";
    refs.enableNotificationsBtn.disabled = true;
    refs.toggleScheduleNotificationsBtn.textContent = "更新通知: 未対応";
    refs.toggleRequestNotificationsBtn.textContent = "確認依頼通知: 未対応";
    refs.toggleScheduleNotificationsBtn.disabled = true;
    refs.toggleRequestNotificationsBtn.disabled = true;
    return;
  }

  if (Notification.permission === "granted") {
    refs.notificationStatus.textContent = "端末通知: 許可済み";
    refs.enableNotificationsBtn.textContent = "端末通知を再確認";
    refs.enableNotificationsBtn.disabled = false;
    refs.toggleScheduleNotificationsBtn.textContent = scheduleNotificationEnabled
      ? "更新通知を無効にする"
      : "更新通知を有効にする";
    refs.toggleRequestNotificationsBtn.textContent = requestNotificationEnabled
      ? "確認依頼通知を無効にする"
      : "確認依頼通知を有効にする";
    refs.toggleScheduleNotificationsBtn.disabled = false;
    refs.toggleRequestNotificationsBtn.disabled = false;
    return;
  }

  if (Notification.permission === "denied") {
    refs.notificationStatus.textContent = "端末通知: ブロックされています";
    refs.enableNotificationsBtn.textContent = "通知設定を確認";
    refs.enableNotificationsBtn.disabled = true;
    refs.toggleScheduleNotificationsBtn.textContent = "更新通知を有効にする";
    refs.toggleRequestNotificationsBtn.textContent = "確認依頼通知を有効にする";
    refs.toggleScheduleNotificationsBtn.disabled = true;
    refs.toggleRequestNotificationsBtn.disabled = true;
    return;
  }

  refs.notificationStatus.textContent = "端末通知: 未設定";
  refs.enableNotificationsBtn.textContent = "通知を有効にする";
  refs.enableNotificationsBtn.disabled = false;
  refs.toggleScheduleNotificationsBtn.textContent = scheduleNotificationEnabled
    ? "更新通知を無効にする"
    : "更新通知を有効にする";
  refs.toggleRequestNotificationsBtn.textContent = requestNotificationEnabled
    ? "確認依頼通知を無効にする"
    : "確認依頼通知を有効にする";
  refs.toggleScheduleNotificationsBtn.disabled = true;
  refs.toggleRequestNotificationsBtn.disabled = true;
}

async function requestBrowserNotificationPermission() {
  if (!("Notification" in window)) {
    setNotice("このブラウザでは端末通知を利用できません。");
    syncNotificationUi();
    return;
  }

  if (Notification.permission === "granted") {
    syncNotificationUi();
    setNotice("端末通知は許可済みです。更新通知・確認依頼通知は個別ボタンで切り替えてください。");
    return;
  }

  const permission = await Notification.requestPermission();
  syncNotificationUi();

  if (permission === "granted") {
    setScheduleNotificationEnabled(true);
    setRequestNotificationEnabled(true);
    setNotice("端末通知を有効にしました。他の利用者の更新時に通知します。");
    return;
  }

  setNotice("端末通知は有効化されませんでした。画面内通知は引き続き表示されます。");
}

async function handleAuthStateChanged(user) {
  currentFirebaseUser = user;

  if (!user) {
    if (isAdminPage) {
      // 管理者ページで未ログイン状態になった場合は通常ログイン導線へ戻す
      window.location.href = "overall.html";
      return;
    }

    stopCloudListener();
    state.currentUser = "";
    state.currentUserId = "";
    state.isAdmin = false;
    state.editTarget = null;
    pendingLoginId = "";
    pendingLoginDisplayName = "";
    pendingLoginPassword = "";
    updatePageLock();
    syncAuthUi();
    syncAdminUi();
    syncLoginForm();
    localStorage.setItem(STORAGE_KEY, JSON.stringify(buildLocalPayload()));
    if (requiresAuth && refs.loginDialog) {
      openDialog(refs.loginDialog);
    }
    setNotice("ログアウトしました。ログイン後に利用できます。");
    return;
  }

  const authLoginId = getLoginIdFromAuthUser(user);
  const cachedProfile = getAuthProfile(user);
  const authAccount = authLoginId ? findAccountByLoginId(authLoginId) : null;
  if (authLoginId && (authAccount || isAdminLoginId(authLoginId))) {
    state.currentUserId = authLoginId;
    state.currentUser = authAccount?.name || authLoginId;
  } else if (pendingLoginId) {
    state.currentUserId = pendingLoginId;
    state.currentUser = pendingLoginDisplayName || pendingLoginId;
  } else if (cachedProfile?.loginId) {
    state.currentUserId = normalizeLoginId(cachedProfile.loginId);
    state.currentUser = normalizeDisplayName(cachedProfile.displayName || cachedProfile.loginId);
  }

  syncCurrentUserFromLoginId();
  if (pendingLoginPassword) {
    const account = findAccountByLoginId(state.currentUserId);
    if (account && normalizeLoginPassword(account.password || "") !== pendingLoginPassword) {
      account.password = pendingLoginPassword;
      saveState();
    }
  }
  syncAuthProfileDisplayName(user, state.currentUserId);

  state.isAdmin = await detectAdminUser(user);
  const currentUserAddedToStaff = ensureCurrentUserInStaffAccounts();
  setAuthProfile(user, state.currentUserId, state.currentUser);
  pendingLoginId = "";
  pendingLoginDisplayName = "";
  pendingLoginPassword = "";

  // 管理者は管理者ページのみ、非管理者は管理者ページに入れない
  if (state.isAdmin && !isAdminPage) {
    window.location.href = "admin.html";
    return;
  }
  if (!state.isAdmin && isAdminPage) {
    window.location.href = "overall.html";
    return;
  }

  updatePageLock();
  syncAuthUi();
  syncAdminUi();
  syncLoginForm();
  if (refs.loginDialog?.open) {
    closeDialog(refs.loginDialog);
  }
  startCloudListener();
  localStorage.setItem(STORAGE_KEY, JSON.stringify(buildLocalPayload()));
  if (currentUserAddedToStaff) {
    saveState();
  }
  const signedInLabel = state.currentUser || state.currentUserId || "利用者";
  setNotice(`${signedInLabel}${state.isAdmin ? "（管理者）" : ""}でログインしました。`);
  await render();
}

async function detectAdminUser(user) {
  if (!user || !firebaseAuth) {
    return false;
  }

  const authLoginId = normalizeLoginId(getLoginIdFromAuthUser(user));
  if (isAdminLoginId(authLoginId)) {
    return true;
  }

  if (isAdminLoginId(state.currentUserId)) {
    return true;
  }

  if (isAdminLoginId(pendingLoginId)) {
    return true;
  }

  const userEmail = String(user.email || "").toLowerCase();
  const adminAuthEmails = new Set(buildAdminAuthEmailCandidates().map((email) => String(email).toLowerCase()));
  if (adminAuthEmails.has(userEmail)) {
    return true;
  }

  try {
    const tokenResult = await user.getIdTokenResult();
    return tokenResult?.claims?.admin === true;
  } catch (error) {
    return false;
  }
}

function isAdminLoginId(loginId) {
  const normalized = normalizeLoginId(loginId);
  if (!normalized) {
    return false;
  }
  return getAdminLoginIdCandidates().includes(normalized);
}

function getAdminLoginIdCandidates() {
  return [...new Set([ADMIN_LOGIN_ID, ...ADMIN_LOGIN_ID_ALIASES].map((value) => normalizeLoginId(value)).filter((value) => Boolean(value)))];
}

async function ensureAdminAccount(loginId, loginPassword) {
  if (!firebaseAuth || !isAdminCredential(loginId, loginPassword)) {
    return;
  }

  // 管理者は専用の内部メールを優先し、ID名との衝突を避ける
  for (const email of buildAdminAuthEmailCandidates()) {
    try {
      await firebaseAuth.createUserWithEmailAndPassword(email, ADMIN_PASSWORD);
      await firebaseAuth.signOut();
      return;
    } catch (error) {
      const code = error?.code || "";
      if (code === "auth/email-already-in-use") {
        continue;
      }
      // 予期しないエラーはコンソールに残すだけで処理を止めない
      console.warn("ensureAdminAccount:", code);
      return;
    }
  }
}

function isAdminCredential(loginId, loginPassword) {
  return isAdminLoginId(loginId)
    && normalizeLoginPassword(loginPassword) === normalizeLoginPassword(ADMIN_PASSWORD);
}

async function createUserWithoutSwitchingSession(email, password) {
  const config = window.__FIREBASE_CONFIG__;
  const secondaryName = `register-${Date.now()}`;
  const secondaryApp = window.firebase.initializeApp(config, secondaryName);

  try {
    const secondaryAuth = secondaryApp.auth();
    return await secondaryAuth.createUserWithEmailAndPassword(email, password);
  } finally {
    await secondaryApp.delete();
  }
}

async function changeUserPasswordWithoutSwitchingSession(loginId, currentPassword, newPassword) {
  const config = window.__FIREBASE_CONFIG__;
  const secondaryName = `password-change-${Date.now()}`;
  const secondaryApp = window.firebase.initializeApp(config, secondaryName);

  try {
    const secondaryAuth = secondaryApp.auth();
    const candidates = buildAuthEmailCandidates(loginId);
    let lastError = null;

    for (const email of candidates) {
      try {
        await secondaryAuth.signInWithEmailAndPassword(email, currentPassword);
        break;
      } catch (error) {
        lastError = error;
        const code = error?.code || "";
        if (
          code === "auth/user-not-found"
          || code === "auth/invalid-credential"
          || code === "auth/invalid-login-credentials"
        ) {
          continue;
        }
        throw error;
      }
    }

    if (!secondaryAuth.currentUser) {
      throw lastError || new Error("password-change-sign-in-failed");
    }

    await secondaryAuth.currentUser.updatePassword(newPassword);
  } finally {
    try {
      await secondaryApp.auth().signOut();
    } catch (error) {
      // no-op
    }
    await secondaryApp.delete();
  }
}

function stopCloudListener() {
  if (cloudUnsubscribe) {
    cloudUnsubscribe();
    cloudUnsubscribe = null;
  }

  if (cloudSaveTimer) {
    clearTimeout(cloudSaveTimer);
    cloudSaveTimer = null;
  }

  lastKnownRemoteUpdatedAt = "";
  lastLocalSaveUpdatedAt = "";
}

function updatePageLock() {
  if (!requiresAuth) {
    document.body.classList.remove("auth-locked");
    return;
  }

  document.body.classList.toggle("auth-locked", !currentFirebaseUser);
}

function toStaffAccount(item) {
  const id = normalizeLoginId(item.id || item.name || "");
  return {
    id,
    name: normalizeDisplayName(item.name || item.id || ""),
    password: normalizeLoginPassword(item.password || ""),
  };
}

async function migrateLegacyAccountOnLogin(loginId, loginPassword, loginError) {
  if (!isAuthUserMissingError(loginError)) {
    return false;
  }

  const legacy = findAccountByLoginId(loginId);
  if (!legacy) {
    return false;
  }

  const legacyPassword = normalizeLoginPassword(legacy.password || "");
  if (!legacyPassword || legacyPassword !== normalizeLoginPassword(loginPassword)) {
    return false;
  }

  try {
    await firebaseAuth.createUserWithEmailAndPassword(buildAuthEmail(loginId), loginPassword);
    setNotice("旧アカウントをFirebase認証へ移行しました。再ログイン不要で続行します。");
    return true;
  } catch (migrationError) {
    if (migrationError?.code === "auth/email-already-in-use") {
      try {
        await signInWithLoginId(loginId, loginPassword);
        return true;
      } catch (signInError) {
        return false;
      }
    }
    return false;
  }
}

function isAuthUserMissingError(error) {
  const code = error?.code || "";
  // Firebase v9+ では auth/invalid-login-credentials に統合された
  return (
    code === "auth/user-not-found" ||
    code === "auth/invalid-credential" ||
    code === "auth/invalid-login-credentials" ||
    code === "auth/user-disabled"
  );
}

function buildAuthEmail(loginId) {
  return `${encodeLoginIdForEmail(loginId)}@${AUTH_EMAIL_DOMAIN}`;
}

function buildAdminAuthEmailCandidates() {
  return [
    `${ADMIN_AUTH_LOCAL_PART}@${AUTH_EMAIL_DOMAIN}`,
    ...getAdminLoginIdCandidates().map((loginId) => buildAuthEmail(loginId)),
  ];
}

function buildAuthEmailCandidates(loginId) {
  const normalized = normalizeLoginId(loginId);
  if (!normalized) {
    return [];
  }

  const candidates = isAdminLoginId(normalized)
    ? [...buildAdminAuthEmailCandidates(), ...[
      `${encodeLoginIdForEmail(normalized)}@${AUTH_EMAIL_DOMAIN}`,
      `${encodeURIComponent(normalized)}@${AUTH_EMAIL_DOMAIN}`,
      `${normalized}@${AUTH_EMAIL_DOMAIN}`,
    ]]
    : [
    `${encodeLoginIdForEmail(normalized)}@${AUTH_EMAIL_DOMAIN}`,
    `${encodeURIComponent(normalized)}@${AUTH_EMAIL_DOMAIN}`,
    `${normalized}@${AUTH_EMAIL_DOMAIN}`,
  ];

  return [...new Set(candidates)].filter((email) => isValidAuthEmail(email));
}

function isValidAuthEmail(email) {
  return /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(String(email || ""));
}

async function signInWithLoginId(loginId, loginPassword) {
  if (!firebaseAuth) {
    throw new Error("firebaseAuth is not initialized");
  }

  const candidates = buildAuthEmailCandidates(loginId);
  const allowLegacyFallback = shouldTryLegacyEmailFallback(loginId, loginPassword);
  let lastError = null;

  for (const email of candidates) {
    try {
      return await firebaseAuth.signInWithEmailAndPassword(email, loginPassword);
    } catch (error) {
      lastError = error;
      const code = error?.code || "";

      // ユーザー未登録時のみ次候補へ進む。
      // invalid-login-credentials は誤パスワードでも発生するため無条件で続行すると
      // 短時間で試行回数が増えて auth/too-many-requests を誘発しやすい。
      if (code === "auth/user-not-found") {
        continue;
      }

      // 旧形式メールの後方互換は、ローカル既知パスワード一致時のみ許可して総試行数を抑える。
      if (
        allowLegacyFallback &&
        (code === "auth/invalid-credential" || code === "auth/invalid-login-credentials")
      ) {
        continue;
      }

      // それ以外は即時失敗とみなす
      throw error;
    }
  }

  throw lastError || new Error("sign-in failed");
}

function shouldTryLegacyEmailFallback(loginId, loginPassword) {
  if (isAdminLoginId(loginId)) {
    return true;
  }

  const account = findAccountByLoginId(loginId);
  if (!account) {
    return false;
  }

  return normalizeLoginPassword(account.password || "") === normalizeLoginPassword(loginPassword);
}

function getLoginIdFromAuthUser(user) {
  const profileLoginId = normalizeLoginId(user?.displayName || "");
  if (profileLoginId) {
    return profileLoginId;
  }

  const email = String(user?.email || "");
  if (!email.includes("@")) {
    return "";
  }

  const localPart = email.split("@")[0] || "";
  const decoded = decodeLoginIdFromEmailLocal(localPart);
  if (decoded && !containsReplacementChar(decoded) && isKnownLoginId(decoded)) {
    return normalizeLoginId(decoded);
  }

  const mapped = findLoginIdByAuthLocalPart(localPart);
  if (mapped) {
    return mapped;
  }

  try {
    const decodedUri = decodeURIComponent(localPart);
    if (decodedUri && !containsReplacementChar(decodedUri) && isKnownLoginId(decodedUri)) {
      return normalizeLoginId(decodedUri);
    }
  } catch (error) {
    // legacy形式でURIエンコードされていない場合は無視
  }

  // 既存データと一致確認できない場合の最後の後方互換フォールバック
  if (decoded && !containsReplacementChar(decoded)) {
    return normalizeLoginId(decoded);
  }

  return "";
}

function encodeLoginIdForEmail(value) {
  const normalized = normalizeLoginId(value);
  const bytes = new TextEncoder().encode(normalized);
  let binary = "";
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function decodeLoginIdFromEmailLocal(value) {
  if (!value) {
    return "";
  }

  try {
    const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
    const padded = base64 + "===".slice((base64.length + 3) % 4);
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
    const decoded = new TextDecoder().decode(bytes);
    return normalizeLoginId(decoded);
  } catch (error) {
    return "";
  }
}

function findLoginIdByAuthLocalPart(localPart) {
  if (!localPart) {
    return "";
  }

  const normalizedLocal = normalizeLoginId(localPart);
  const normalizedLocalLower = normalizedLocal.toLowerCase();
  for (const account of state.staffAccounts) {
    const accountId = normalizeLoginId(account.id);
    if (!accountId) {
      continue;
    }

    const encoded = encodeLoginIdForEmail(accountId);
    if (encoded === localPart || encoded.toLowerCase() === normalizedLocalLower) {
      return accountId;
    }

    const encodedUri = encodeURIComponent(accountId);
    if (encodedUri === localPart || encodedUri.toLowerCase() === normalizedLocalLower) {
      return accountId;
    }

    if (accountId === normalizedLocal || accountId.toLowerCase() === normalizedLocalLower) {
      return accountId;
    }
  }

  return "";
}

function isKnownLoginId(value) {
  const normalized = normalizeLoginId(value);
  if (!normalized) {
    return false;
  }
  if (isAdminLoginId(normalized)) {
    return true;
  }
  return state.staffAccounts.some((account) => normalizeLoginId(account.id) === normalized);
}

function containsReplacementChar(value) {
  return String(value).includes("�");
}

function loadAuthProfileMap() {
  try {
    const raw = localStorage.getItem(AUTH_PROFILE_MAP_KEY);
    if (!raw) {
      authProfileMap = {};
      return;
    }

    const parsed = JSON.parse(raw);
    authProfileMap = parsed && typeof parsed === "object" ? parsed : {};
  } catch (error) {
    authProfileMap = {};
  }
}

function saveAuthProfileMap() {
  localStorage.setItem(AUTH_PROFILE_MAP_KEY, JSON.stringify(authProfileMap));
}

function getAuthProfile(user) {
  const key = String(user?.uid || user?.email || "");
  if (!key) {
    return null;
  }
  return authProfileMap[key] || null;
}

function setAuthProfile(user, loginId, displayName) {
  const key = String(user?.uid || user?.email || "");
  const normalizedId = normalizeLoginId(loginId);
  if (!key || !normalizedId) {
    return;
  }

  authProfileMap[key] = {
    loginId: normalizedId,
    displayName: normalizeDisplayName(displayName || normalizedId),
    updatedAt: new Date().toISOString(),
  };
  saveAuthProfileMap();
}

function syncAuthProfileDisplayName(user, loginId) {
  const normalizedId = normalizeLoginId(loginId);
  if (!user || !normalizedId || user.displayName === normalizedId) {
    return;
  }

  user.updateProfile({ displayName: normalizedId }).catch(() => {
    // profile更新不可でも認証処理は継続する
  });
}

function convertFirebaseAuthError(error) {
  const code = error?.code || "";
  switch (code) {
    case "auth/invalid-login-credentials":
    case "auth/invalid-credential":
    case "auth/user-not-found":
    case "auth/wrong-password":
      return "ログイン失敗: IDが未登録、またはパスワードが違います。新しいPCでは最初に管理者で利用者登録を確認してください。";
    case "auth/invalid-email":
      return "ログイン失敗: ID形式が不正です。IDに不要な空白がないか確認してください。";
    case "auth/too-many-requests":
      return "ログイン試行回数が多すぎます。しばらく待ってから再試行してください。";
    case "auth/operation-not-allowed":
      return "Firebase Authentication のメール/パスワード認証が無効です。Firebase Consoleで有効化してください。";
    case "auth/invalid-api-key":
      return "Firebase APIキーが無効です。firebase-config.js の設定を確認してください。";
    case "auth/email-already-in-use":
      return "この名前(ID)はすでに登録されています。";
    case "auth/weak-password":
      return "パスワードは任意の8桁の数字で入力してください。";
    case "auth/network-request-failed":
      return "通信に失敗しました。ネットワークを確認してください。";
    default:
      return `Firebase Authentication の処理に失敗しました。(${code || "unknown"})`;
  }
}

function normalizeTimestamp(value) {
  return typeof value === "string" ? value : "";
}

function formatTimeLabel(value) {
  if (!value) {
    return "";
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "";
  }

  return `(${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")})`;
}

function formatDateTimeLabel(value) {
  if (!value) {
    return "不明";
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "不明";
  }

  return `${date.getFullYear()}/${String(date.getMonth() + 1).padStart(2, "0")}/${String(date.getDate()).padStart(2, "0")} ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function normalizeLoginId(value) {
  return String(value)
    .trim()
    .replaceAll(" ", "")
    .replaceAll("　", "");
}

function normalizeDisplayName(value) {
  return String(value).trim().replaceAll("　", " ").replace(/\s+/g, " ");
}

function normalizeLoginPassword(value) {
  return String(value).replaceAll("-", "").replaceAll("/", "").trim();
}

function maskPassword(password) {
  return "Firebase認証";
}

function findAccountByCredentials(loginId, loginPassword) {
  const normalizedId = normalizeLoginId(loginId);
  const normalizedPassword = normalizeLoginPassword(loginPassword);
  return (
    state.staffAccounts.find(
      (item) => normalizeLoginId(item.id) === normalizedId && normalizeLoginPassword(item.password) === normalizedPassword,
    ) || null
  );
}

function findAccountByLoginId(loginId) {
  const normalizedId = normalizeLoginId(loginId);
  return state.staffAccounts.find((item) => normalizeLoginId(item.id) === normalizedId) || null;
}

function findLoginIdByUserName(name) {
  const account = state.staffAccounts.find((item) => item.name === name);
  return account?.id || "";
}

function syncCurrentUserFromLoginId() {
  const loginId = normalizeLoginId(state.currentUserId);
  if (!loginId) {
    return;
  }

  const account = findAccountByLoginId(loginId);
  if (account?.name) {
    state.currentUser = account.name;
    return;
  }

  if (!state.currentUser) {
    state.currentUser = loginId;
  }
}

function refreshStaffFromAccounts() {
  const names = state.staffAccounts.map((item) => item.name).filter((name) => Boolean(name));
  state.staff = [...new Set(names)];
}

function ensureCurrentUserInStaffAccounts() {
  const loginId = normalizeLoginId(state.currentUserId);
  if (!loginId || isAdminLoginId(loginId)) {
    return false;
  }

  if (findAccountByLoginId(loginId)) {
    return false;
  }

  const displayName = normalizeDisplayName(state.currentUser || loginId) || loginId;
  state.staffAccounts.push(toStaffAccount({ id: loginId, name: displayName }));
  refreshStaffFromAccounts();
  state.currentUser = displayName;
  return true;
}

function setNotice(text) {
  if (refs.notice) {
    refs.notice.textContent = text;
  }
}

function getMonday(baseDate) {
  const date = new Date(baseDate);
  date.setHours(0, 0, 0, 0);
  const day = date.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  date.setDate(date.getDate() + diff);
  return date;
}

function addDays(date, days) {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

function getMonthStart(baseDate) {
  const d = new Date(baseDate);
  d.setHours(0, 0, 0, 0);
  d.setDate(1);
  return d;
}

function addMonths(date, months) {
  const d = new Date(date);
  d.setDate(1);
  d.setMonth(d.getMonth() + months);
  return getMonthStart(d);
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function getWeekDates(monday) {
  return Array.from({ length: 7 }, (_, i) => addDays(monday, i));
}

function toISODate(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function fromISODate(dateStr) {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(y, m - 1, d);
}

function entryKey(name, dateStr) {
  return `${name}::${dateStr}`;
}

function formatDateJP(date) {
  return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`;
}

function escapeHtml(text) {
  return String(text)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

// Function to log in using only a username
async function loginWithUsernameOnly(username, password) {
    const db = firebase.firestore();
    try {
        // Search for the user by username
        const userSnapshot = await db.collection('users').where('username', '==', username).get();
        if (userSnapshot.empty) {
            throw new Error('ユーザー名が見つかりません');
        }

        // Retrieve the user data
        const userData = userSnapshot.docs[0].data();
        const storedPassword = userData.password; // Password stored in Firestore

        // Check if the password matches
        if (storedPassword !== password) {
            throw new Error('パスワードが正しくありません');
        }

        console.log('ログイン成功');
        alert('ログイン成功しました');
    } catch (error) {
        console.error('ログインエラー:', error.message);
        alert('ログインに失敗しました: ' + error.message);
    }
}
