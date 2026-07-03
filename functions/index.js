const { onRequest } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");

admin.initializeApp();

exports.pushNotify = onRequest(async (req, res) => {
  try {
    if (req.method !== "POST") {
      res.status(405).send("Method Not Allowed");
      return;
    }

    // 送信元がFirebase Authでログイン済みの利用者であることを確認する
    // （未認証の第三者が任意の利用者へPushを送りつけられる状態を避けるため）
    const authHeader = String(req.get("Authorization") || "");
    const idToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
    if (!idToken) {
      res.status(401).json({ error: "Authorization header (Bearer <idToken>) is required" });
      return;
    }
    try {
      await admin.auth().verifyIdToken(idToken);
    } catch (error) {
      res.status(401).json({ error: "invalid id token" });
      return;
    }

    const {
      targetId,
      requesterName,
      ownerName,
      startDate,
      repeatDays,
      requestId,
    } = req.body || {};

    if (!targetId) {
      res.status(400).json({ error: "targetId is required" });
      return;
    }

    const snapshot = await admin.firestore()
      .collection("pushTokens")
      .where("loginId", "==", String(targetId))
      .where("enabled", "==", true)
      .get();

    const tokens = snapshot.docs.map((doc) => doc.id).filter(Boolean);
    if (tokens.length === 0) {
      res.status(200).json({ ok: true, sent: 0 });
      return;
    }

    const multicast = {
      tokens,
      notification: {
        title: "確認依頼が届きました",
        body: `${requesterName || "利用者"} から ${ownerName || "予定"} の確認依頼があります`,
      },
      data: {
        url: `/overall.html?requestId=${encodeURIComponent(String(requestId || ""))}`,
        type: "confirmation-request",
        startDate: String(startDate || ""),
        repeatDays: String(repeatDays || "1"),
      },
      webpush: {
        fcmOptions: {
          link: "https://d1424-da.github.io/schedule-web-app/overall.html",
        },
      },
    };

    const result = await admin.messaging().sendEachForMulticast(multicast);
    res.status(200).json({ ok: true, sent: result.successCount, failed: result.failureCount });
  } catch (error) {
    res.status(500).json({ error: String(error?.message || error) });
  }
});
