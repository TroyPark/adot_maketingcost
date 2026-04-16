const functions = require("firebase-functions/v1");
const https = require("https");
const crypto = require("crypto");
const admin = require("firebase-admin");

admin.initializeApp();

// ⚙️ 설정값
const COLLECTION_NAME = "inquiries";
const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL;

// NCP SENS 알림톡 설정
const NCP_ACCESS_KEY = process.env.NCP_ACCESS_KEY;
const NCP_SECRET_KEY = process.env.NCP_SECRET_KEY;
const NCP_SENS_SERVICE_ID = process.env.NCP_SENS_SERVICE_ID;
const KAKAO_CHANNEL_ID = process.env.KAKAO_CHANNEL_ID;
const KAKAO_TEMPLATE_CODE = process.env.KAKAO_TEMPLATE_CODE;

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

// 💬 답변 완료 시 카카오 알림톡 발송
exports.sendAlimtalkOnReply = functions.firestore
    .document("abpInquiries/{docId}")
    .onUpdate(async (change) => {
        const before = change.before.data();
        const after = change.after.data();

        // 답변완료로 변경된 경우에만 발송
        if (before.status === "answered" || after.status !== "answered") {
            return null;
        }

        const originalInquiryId = after.originalInquiryId;
        if (!originalInquiryId) {
            console.warn("originalInquiryId 없음 — 알림톡 발송 생략");
            return null;
        }

        // 원본 문의에서 휴대폰 번호 조회
        const inquiryDoc = await admin.firestore()
            .collection("inquiries")
            .doc(originalInquiryId)
            .get();

        if (!inquiryDoc.exists) {
            console.warn("원본 문의 문서 없음:", originalInquiryId);
            return null;
        }

        const notifyContact = inquiryDoc.data().notifyContact;
        if (!notifyContact) {
            console.warn("notifyContact 없음 — 알림톡 발송 생략");
            return null;
        }

        try {
            await sendSensAlimtalk(notifyContact, originalInquiryId);
            console.log("알림톡 발송 완료:", notifyContact);
        } catch (err) {
            console.error("알림톡 발송 실패:", err);
        }

        return null;
    });

// 📲 NCP SENS 알림톡 API 호출
function sendSensAlimtalk(to, inquiryId) {
    const method = "POST";
    const path = `/alimtalk/v2/services/${NCP_SENS_SERVICE_ID}/messages`;
    const timestamp = Date.now().toString();

    const message = `${method} ${path}\n${timestamp}\n${NCP_ACCESS_KEY}`;
    const signature = crypto
        .createHmac("sha256", NCP_SECRET_KEY)
        .update(message)
        .digest("base64");

    const body = JSON.stringify({
        plusFriendId: KAKAO_CHANNEL_ID,
        templateCode: KAKAO_TEMPLATE_CODE,
        messages: [
            {
                to,
                content: "기다려 주셔서 감사합니다. 문의 주신 내용에 답변이 완료되었습니다.",
                buttons: [
                    {
                        type: "WL",
                        name: "답변확인하기",
                        linkMobile: `https://troypark.github.io/user?path=inquiries&${inquiryId}&open`,
                        linkPc: `https://troypark.github.io/user?path=inquiries&${inquiryId}&open`,
                    },
                ],
            },
        ],
    });

    return new Promise((resolve, reject) => {
        const req = https.request(
            {
                hostname: "sens.apigw.ntruss.com",
                path,
                method,
                headers: {
                    "Content-Type": "application/json",
                    "Content-Length": Buffer.byteLength(body),
                    "x-ncp-apigw-timestamp": timestamp,
                    "x-ncp-iam-access-key": NCP_ACCESS_KEY,
                    "x-ncp-apigw-signature-v2": signature,
                },
            },
            (res) => {
                let data = "";
                res.on("data", (chunk) => { data += chunk; });
                res.on("end", () => {
                    if (res.statusCode >= 200 && res.statusCode < 300) {
                        resolve(data);
                    } else {
                        reject(new Error(`SENS API 오류 ${res.statusCode}: ${data}`));
                    }
                });
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

        // Firebase Auth 에러 코드에 따라 적절한 HttpsError 반환
        if (error.code === "auth/email-already-exists") {
            throw new functions.https.HttpsError("already-exists", "이미 사용 중인 이메일입니다.");
        } else if (error.code === "auth/invalid-email") {
            throw new functions.https.HttpsError("invalid-argument", "유효하지 않은 이메일 형식입니다.");
        } else if (error.code === "auth/invalid-password") {
            throw new functions.https.HttpsError("invalid-argument", "비밀번호는 6자 이상이어야 합니다.");
        } else if (error.code === "auth/weak-password") {
            throw new functions.https.HttpsError("invalid-argument", "비밀번호가 너무 약합니다. 6자 이상 입력해주세요.");
        } else {
            throw new functions.https.HttpsError("internal", error.message || "사용자 생성 중 오류가 발생했습니다.");
        }
    }
});
