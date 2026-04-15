const functions = require("firebase-functions/v1");
const https = require("https");
const admin = require("firebase-admin");

admin.initializeApp();

// ⚙️ 설정값
const COLLECTION_NAME = "inquiries";
const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL;

// 담당자별 Slack 멘션 ID (실제 Slack ID로 교체)
const MANAGER_SLACK_MENTION = {
    "문성민": "U0ADXDR90QY",
    "이용진": "U0ADXDR90QY",
    "홍수련": "U0ADXDR90QY",
    "조은제": "U0ADXDR90QY",
    "곽동신": "U0ADXDR90QY",
    "정희석": "U0ADXDR90QY",
    "안여진": "U0ADXDR90QY",
    "정현호": "U0ADXDR90QY",
    "박소언": "U0ADXDR90QY",
};

// 팀별 Slack 멘션 ID (팀 Slack ID 확정 후 각 팀별로 교체)
const TEAM_SLACK_MENTION = {
    biz_plan:     "U0ADXDR90QY", // 사업기획팀
    sales_ops:    "U0ADXDR90QY", // 영업지원팀
    hrd_academy:  "U0ADXDR90QY", // 학원HRD팀
    eng_lab:      "U0ADXDR90QY", // 영어연구소
    content_prod: "U0ADXDR90QY", // 콘텐츠제작팀
    it_dev:       "U0ADXDR90QY", // IT본부
    corp_admin:   "U0ADXDR90QY", // 경영지원팀
    biz_mk1:      "U0ADXDR90QY", // 사업마케팅1팀
    biz_mk2:      "U0ADXDR90QY", // 사업마케팅2팀
};

// ✍️ 문의 작성 알림
exports.notifySlackOnCreate = functions.firestore
    .document(`${COLLECTION_NAME}/{docId}`)
    .onCreate((snap, context) => {
        const doc = snap.data();
        const message = buildSlackMessage("📬 새 문의가 접수되었습니다", doc, context.params.docId);
        return sendToSlack(message);
    });

// 🔄 문의 수정 알림
exports.notifySlackOnUpdate = functions.firestore
    .document(`${COLLECTION_NAME}/{docId}`)
    .onUpdate((change, context) => {
        const doc = change.after.data();
        const message = buildSlackMessage("🔄 문의가 수정되었습니다", doc, context.params.docId);
        return sendToSlack(message);
    });

// 📨 Slack 메시지 포맷 구성
function buildSlackMessage(headerText, doc, docId) {
    const teamId = doc.abpTargetTeam;
    const slackId = teamId && TEAM_SLACK_MENTION[teamId];
    const mentionText = slackId ? `<@${slackId}>` : null;

    const majorLabel = doc.inquiryMajorLabel || doc.inquiryMajor || "-";
    const minorLabel = doc.inquiryMinorLabel || doc.inquiryMinor || null;
    const categoryText = minorLabel ? `${majorLabel} › ${minorLabel}` : majorLabel;

    return {
        blocks: [
            {
                type: "header",
                text: { type: "plain_text", text: headerText },
            },
            {
                type: "section",
                fields: [
                    { type: "mrkdwn", text: `*제목*\n${doc.title || "(제목 없음)"}` },
                    { type: "mrkdwn", text: `*작성자*\n${doc.userName || "(알 수 없음)"}` },
                ],
            },
            {
                type: "section",
                fields: [
                    { type: "mrkdwn", text: `*지점*\n${doc.branchName || "-"}` },
                    { type: "mrkdwn", text: `*상태*\n${doc.status === 'answered' ? '답변완료' : doc.status === 'pending' ? '대기중' : doc.status || "-"}` },
                ],
            },
            {
                type: "section",
                fields: [
                    { type: "mrkdwn", text: `*문의 유형*\n${categoryText}` },
                    ...(mentionText ? [{ type: "mrkdwn", text: `*담당팀*\n${mentionText}` }] : []),
                ],
            },
            ...(doc.manager ? [{
                type: "section",
                fields: [
                    { type: "mrkdwn", text: `*지점 담당자*\n${doc.manager} (<@${MANAGER_SLACK_MENTION[doc.manager] || doc.manager}>)` },
                ],
            }] : []),
            {
                type: "section",
                text: {
                    type: "mrkdwn",
                    text: `*내용 미리보기*\n${(doc.content || "").slice(0, 150)}${(doc.content || "").length > 150 ? "..." : ""}`,
                },
            },
            {
                type: "context",
                elements: [
                    {
                        type: "mrkdwn",
                        text: `이메일: ${doc.userEmail || "-"} | 문서 ID: \`${docId}\` | ${new Date().toLocaleString("ko-KR", { timeZone: "Asia/Seoul" })}`,
                    },
                ],
            },
        ],
    };
}

// 📡 Slack으로 전송
function sendToSlack(message) {
    const url = new URL(SLACK_WEBHOOK_URL);
    const body = JSON.stringify(message);

    return new Promise((resolve, reject) => {
        const req = https.request(
            {
                hostname: url.hostname,
                path: url.pathname,
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "Content-Length": Buffer.byteLength(body),
                },
            },
            (res) => {
                res.on("data", () => { });
                res.on("end", resolve);
            }
        );
        req.on("error", reject);
        req.write(body);
        req.end();
    });
}

// 👤 관리자용 사용자 생성
exports.createUser = functions.https.onCall(async (data, context) => {
    // 관리자 인증 확인
    if (!context.auth) {
        throw new functions.https.HttpsError("unauthenticated", "로그인이 필요합니다.");
    }

    const { email, password, displayName, branchName, team, manager, uniquePassword } = data;

    if (!email || !password) {
        throw new functions.https.HttpsError("invalid-argument", "이메일과 비밀번호는 필수입니다.");
    }

    try {
        // Firebase Auth에 사용자 생성
        const userRecord = await admin.auth().createUser({
            email,
            password,
            displayName: displayName || email.split("@")[0],
        });

        // Firestore에 사용자 정보 저장
        await admin.firestore().collection("users").doc(userRecord.uid).set({
            uid: userRecord.uid,
            email,
            displayName: displayName || email.split("@")[0],
            branchName: branchName || "",
            team: team || "",
            manager: manager || "",
            role: "user",
            isActive: true,
            marketingPassword: uniquePassword || "0000",
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
            lastLoginAt: null,
        });

        return { success: true, uid: userRecord.uid, email: userRecord.email };
    } catch (error) {
        console.error("createUser 오류:", error);
        throw new functions.https.HttpsError("internal", error.message);
    }
});
