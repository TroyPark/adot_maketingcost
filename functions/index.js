const functions = require("firebase-functions/v1");
const https = require("https");
const crypto = require("crypto");
const admin = require("firebase-admin");

admin.initializeApp();

// ⚙️ 설정값
const COLLECTION_NAME = "inquiries";
const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;   // Slack Bot OAuth Token (xoxb-...)
const SLACK_CHANNEL_ID = process.env.SLACK_CHANNEL_ID; // 알림 받을 채널 ID (C...)

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

// 팀 한국어 라벨
const TEAM_LABEL = {
    biz_plan:     "사업기획팀",
    sales_ops:    "영업지원팀",
    hrd_academy:  "학원HRD팀",
    eng_lab:      "영어연구소",
    content_prod: "콘텐츠제작팀",
    it_dev:       "IT본부",
    corp_admin:   "경영지원팀",
    biz_mk1:      "사업마케팅1팀",
    biz_mk2:      "사업마케팅2팀",
};

// 지점명으로 담당자 조회
async function getManagerForBranch(branchName) {
    if (!branchName) return null;
    const snapshot = await admin.firestore()
        .collection("users")
        .where("branchName", "==", branchName)
        .limit(1)
        .get();
    if (snapshot.empty) return null;
    return snapshot.docs[0].data().manager || null;
}

function getCategoryText(doc) {
    const major = doc.inquiryMajorLabel || doc.inquiryMajor || "-";
    const minor = doc.inquiryMinorLabel || doc.inquiryMinor || null;
    return minor ? `${major} › ${minor}` : major;
}

// 📨 문의 인입/업데이트 Slack 메시지 Block 구성
function buildInquiryBlocks(doc, manager, docId, previousTeamId = null) {
    const teamId = doc.abpTargetTeam;
    const teamLabel = teamId ? (TEAM_LABEL[teamId] || teamId) : null;
    const prevTeamLabel = previousTeamId ? (TEAM_LABEL[previousTeamId] || previousTeamId) : null;

    const teamSlackId = teamId && TEAM_SLACK_MENTION[teamId];
    const managerSlackId = manager && MANAGER_SLACK_MENTION[manager];

    const categoryText = getCategoryText(doc);
    const isAnswered = doc.status === "answered";
    const statusText = isAnswered ? "✅ 답변완료" : "⏳ 대기중";

    const blocks = [];

    // 멘션 (답변완료 상태에서는 재멘션 생략)
    if (!isAnswered && (teamSlackId || managerSlackId)) {
        const mentionFields = [
            teamSlackId ? { type: "mrkdwn", text: `*담당팀*\n<@${teamSlackId}>` } : null,
            managerSlackId ? { type: "mrkdwn", text: `*지점 담당자*\n<@${managerSlackId}>` } : null,
        ].filter(Boolean);
        blocks.push({
            type: "section",
            fields: mentionFields,
        });
    }

    // 헤더
    const headerTitle = prevTeamLabel && teamLabel
        ? `[${prevTeamLabel}] → [${teamLabel}] 문의 인입`
        : isAnswered
            ? `${categoryText} 문의 - 답변완료`
            : `${categoryText} 문의 인입`;

    blocks.push({
        type: "header",
        text: { type: "plain_text", text: headerTitle.slice(0, 150) },
    });

    // 설명
    const descText = prevTeamLabel && teamLabel
        ? `🔄 *[${prevTeamLabel}] → [${teamLabel}]*\n📬 *${categoryText}* 카테고리의 문의가 인입되었습니다.`
        : isAnswered
            ? `✅ *${categoryText}* 카테고리 문의에 답변이 완료되었습니다.`
            : `📬 *${categoryText}* 카테고리의 문의가 인입되었습니다.`;

    blocks.push({
        type: "section",
        text: { type: "mrkdwn", text: descText },
    });

    // 제목 / 지점
    blocks.push({
        type: "section",
        fields: [
            { type: "mrkdwn", text: `*제목*\n${doc.title || "(제목 없음)"}` },
            { type: "mrkdwn", text: `*지점*\n${doc.branchName || "-"}` },
        ],
    });

    // 내용 미리보기
    const content = doc.content || "";
    blocks.push({
        type: "section",
        text: {
            type: "mrkdwn",
            text: `*내용*\n${content.slice(0, 300)}${content.length > 300 ? "..." : ""}`,
        },
    });

    // 상태 / 작성자
    blocks.push({
        type: "section",
        fields: [
            { type: "mrkdwn", text: `*상태*\n${statusText}` },
            { type: "mrkdwn", text: `*작성자*\n${doc.userName || "-"}` },
        ],
    });

    // 컨텍스트
    blocks.push({
        type: "context",
        elements: [
            {
                type: "mrkdwn",
                text: `문서 ID: \`${docId}\` | ${new Date().toLocaleString("ko-KR", { timeZone: "Asia/Seoul" })}`,
            },
        ],
    });

    return blocks;
}

// ❌ 담당부서 변경으로 인한 취소 메시지 Block 구성
function buildCancelledBlocks(doc, docId) {
    const teamId = doc.abpTargetTeam;
    const teamLabel = teamId ? (TEAM_LABEL[teamId] || teamId) : null;
    const categoryText = getCategoryText(doc);

    return [
        {
            type: "header",
            text: {
                type: "plain_text",
                text: `❌ [취소] ${teamLabel ? `${teamLabel} ` : ""}${categoryText} 문의`.slice(0, 150),
            },
        },
        {
            type: "section",
            text: {
                type: "mrkdwn",
                text: `~담당부서가 변경되었습니다. 아래 새 알림을 확인하세요.~\n\n*제목:* ${doc.title || "(제목 없음)"} | *지점:* ${doc.branchName || "-"}`,
            },
        },
        {
            type: "context",
            elements: [
                {
                    type: "mrkdwn",
                    text: `문서 ID: \`${docId}\` | 취소 처리: ${new Date().toLocaleString("ko-KR", { timeZone: "Asia/Seoul" })}`,
                },
            ],
        },
    ];
}

// 📡 Slack Web API 호출 (chat.postMessage / chat.update 공용)
function callSlackApi(method, payload) {
    const body = JSON.stringify(payload);
    return new Promise((resolve, reject) => {
        const req = https.request(
            {
                hostname: "slack.com",
                path: `/api/${method}`,
                method: "POST",
                headers: {
                    "Content-Type": "application/json; charset=utf-8",
                    "Content-Length": Buffer.byteLength(body),
                    "Authorization": `Bearer ${SLACK_BOT_TOKEN}`,
                },
            },
            (res) => {
                let data = "";
                res.on("data", (chunk) => { data += chunk; });
                res.on("end", () => {
                    try { resolve(JSON.parse(data)); }
                    catch { resolve(null); }
                });
            }
        );
        req.on("error", reject);
        req.write(body);
        req.end();
    });
}

function postSlackMessage(blocks, fallbackText) {
    return callSlackApi("chat.postMessage", {
        channel: SLACK_CHANNEL_ID,
        text: fallbackText,
        blocks,
    });
}

function updateSlackMessage(ts, channelId, blocks, fallbackText) {
    return callSlackApi("chat.update", {
        channel: channelId,
        ts,
        text: fallbackText,
        blocks,
    });
}

// ✍️ 문의 작성 알림
exports.notifySlackOnCreate = functions.firestore
    .document(`${COLLECTION_NAME}/{docId}`)
    .onCreate(async (snap, context) => {
        const doc = snap.data();
        const docId = context.params.docId;

        const manager = doc.manager || await getManagerForBranch(doc.branchName);
        const blocks = buildInquiryBlocks(doc, manager, docId);
        const categoryText = getCategoryText(doc);

        const result = await postSlackMessage(blocks, `📬 ${categoryText} 카테고리의 문의가 인입되었습니다.`);

        if (result && result.ok) {
            // 이후 메시지 업데이트를 위해 ts 저장
            await snap.ref.update({
                slackMessageTs: result.ts,
                slackChannelId: result.channel,
            });
        } else {
            console.error("Slack postMessage 실패:", result);
        }

        return null;
    });

// 🔄 문의 수정 알림 (담당부서 변경 / 답변완료)
exports.notifySlackOnUpdate = functions.firestore
    .document(`${COLLECTION_NAME}/{docId}`)
    .onUpdate(async (change, context) => {
        const before = change.before.data();
        const after = change.after.data();
        const docId = context.params.docId;

        const teamChanged = before.abpTargetTeam !== after.abpTargetTeam;
        const statusAnswered = before.status !== "answered" && after.status === "answered";

        // 관련 변경 없으면 종료 (slackMessageTs 업데이트로 인한 재귀 호출 방지)
        if (!teamChanged && !statusAnswered) return null;

        if (teamChanged) {
            // 기존 메시지 취소 처리
            const existingTs = after.slackMessageTs;
            const existingChannel = after.slackChannelId;
            if (existingTs && existingChannel && before.abpTargetTeam) {
                await updateSlackMessage(
                    existingTs,
                    existingChannel,
                    buildCancelledBlocks(before, docId),
                    "❌ [취소] 담당부서 변경으로 인한 취소"
                );
            }

            // 새 담당부서가 없으면 신규 알림 생략
            if (!after.abpTargetTeam) return null;

            // 신규 담당부서로 새 메시지 전송
            const manager = after.manager || await getManagerForBranch(after.branchName);
            const blocks = buildInquiryBlocks(after, manager, docId, before.abpTargetTeam);
            const categoryText = getCategoryText(after);
            const result = await postSlackMessage(blocks, `📬 ${categoryText} 카테고리의 문의가 인입되었습니다.`);

            if (result && result.ok) {
                await change.after.ref.update({
                    slackMessageTs: result.ts,
                    slackChannelId: result.channel,
                });
            } else {
                console.error("Slack postMessage 실패 (팀 변경):", result);
            }
        }

        // 답변완료 시 기존 메시지 상태 업데이트 (팀 변경과 동시 발생 시 생략)
        if (statusAnswered && !teamChanged) {
            const ts = after.slackMessageTs;
            const channelId = after.slackChannelId;
            if (!ts || !channelId) return null;

            const manager = after.manager || await getManagerForBranch(after.branchName);
            const blocks = buildInquiryBlocks(after, manager, docId);
            const categoryText = getCategoryText(after);
            const result = await updateSlackMessage(ts, channelId, blocks, `✅ [답변완료] ${categoryText} 문의`);

            if (!result || !result.ok) {
                console.error("Slack chat.update 실패 (답변완료):", result);
            }
        }

        return null;
    });

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
