const functions = require("firebase-functions/v1");
const https = require("https");
const crypto = require("crypto");
const admin = require("firebase-admin");

admin.initializeApp();

// ⚙️ 설정값
const COLLECTION_NAME = "inquiries";
const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;   // Slack Bot OAuth Token (xoxb-...)
const BASE_URL = process.env.BASE_URL || 'https://troypark.github.io';
const SLACK_CHANNEL_ID = process.env.SLACK_CHANNEL_ID; // 알림 받을 채널 ID (C...)

// NCP SENS 알림톡 설정
const NCP_ACCESS_KEY = process.env.NCP_ACCESS_KEY;
const NCP_SECRET_KEY = process.env.NCP_SECRET_KEY;
const NCP_SENS_SERVICE_ID = process.env.NCP_SENS_SERVICE_ID;
const KAKAO_CHANNEL_ID = process.env.KAKAO_CHANNEL_ID;
const KAKAO_TEMPLATE_CODE = process.env.KAKAO_TEMPLATE_CODE;


// 팀별 Slack 멘션 ID (팀 Slack ID 확정 후 각 팀별로 교체)
const TEAM_SLACK_MENTION = {
    biz_plan: "U0ADXDR90QY", // 사업기획팀
    sales_ops: "U0ADXDR90QY", // 영업지원팀
    hrd_academy: "U0ADXDR90QY", // 학원HRD팀
    eng_lab: "U0ADXDR90QY", // 영어연구소
    content_prod: "U0ADXDR90QY", // 콘텐츠제작팀
    it_dev: "U0ADXDR90QY", // IT본부
    corp_admin: "U0ADXDR90QY", // 경영지원팀
    biz_mk1: "U0ADXDR90QY", // 사업마케팅1팀
    biz_mk2: "U0ADXDR90QY", // 사업마케팅2팀
};

// 팀 한국어 라벨
const TEAM_LABEL = {
    biz_plan: "사업기획팀",
    sales_ops: "영업지원팀",
    hrd_academy: "학원HRD팀",
    eng_lab: "영어연구소",
    content_prod: "콘텐츠제작팀",
    it_dev: "IT본부",
    corp_admin: "경영지원팀",
    biz_mk1: "사업마케팅1팀",
    biz_mk2: "사업마케팅2팀",
};

// config/managerSlackIds 문서에서 담당자 이름 → Slack ID 조회
async function getManagerSlackId(managerName) {
    if (!managerName) return null;
    const doc = await admin.firestore()
        .collection("config")
        .doc("managerSlackIds")
        .get();
    if (!doc.exists) return null;
    return doc.data()[managerName] || null;
}

// 지점명으로 담당자 이름 + Slack ID 조회
async function getManagerForBranch(branchName, managerName) {
    const name = managerName || await (async () => {
        if (!branchName) return null;
        const snapshot = await admin.firestore()
            .collection("users")
            .where("branchName", "==", branchName)
            .limit(1)
            .get();
        return snapshot.empty ? null : snapshot.docs[0].data().manager || null;
    })();
    if (!name) return null;
    const slackId = await getManagerSlackId(name);
    return { name, slackId };
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
    const managerSlackId = manager?.slackId;

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
            { type: "mrkdwn", text: `*작성자*\n${doc.inquirerName || doc.userName || "-"}` },
        ],
    });

    // 문의함으로 이동 버튼
    if (doc.abpInquiryId) {
        // 일부 문서는 targetTeam만 저장되어 있을 수 있어(abpTargetTeam 미존재) 둘 다 확인
        const resolvedTeamId = doc.abpTargetTeam || doc.targetTeam || null;
        const isBizMarketingTeam = resolvedTeamId === "biz_mk1" || resolvedTeamId === "biz_mk2";
        const inquiryUrl = isBizMarketingTeam
            ? `${BASE_URL}/admin?abpOpen=${doc.abpInquiryId}`
            : `${BASE_URL}/abp?open=${doc.abpInquiryId}`;

        blocks.push({
            type: "actions",
            elements: [
                {
                    type: "button",
                    text: { type: "plain_text", text: "문의함으로 이동", emoji: true },
                    url: inquiryUrl,
                },
            ],
        });
    }

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

        const manager = await getManagerForBranch(doc.branchName, doc.manager);
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
            const manager = await getManagerForBranch(after.branchName, after.manager);
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

            const manager = await getManagerForBranch(after.branchName, after.manager);
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

// ⏰ 미답변 경과 Slack 재알림
// - **언제**: 매일 오전 9시(KST) 실행
// - **대상**: status=pending 이고 createdAt 기준 3일 이상 지난 문의
// - **중복 방지**: lastReminderAt 이후 3일 이내면 스킵
// - **전송 방식**: 원본 Slack 알림이 있으면 thread에 댓글로 재알림, 없으면 새 메시지
exports.remindPendingInquiries = functions.pubsub
    .schedule("0 9 * * *")
    .timeZone("Asia/Seoul")
    .onRun(async () => {
        const now = admin.firestore.Timestamp.now();
        const KST_OFFSET_MS = 9 * 60 * 60 * 1000; // Asia/Seoul (DST 없음)
        const MS_PER_DAY = 24 * 60 * 60 * 1000;
        const WEEKDAY_TARGET_DAYS = 3; // 평일 기준 3일(주말 제외, 공휴일 무시)

        const toKstMidnightMs = (ms) => {
            const kstMs = ms + KST_OFFSET_MS;
            return Math.floor(kstMs / MS_PER_DAY) * MS_PER_DAY - KST_OFFSET_MS;
        };

        const isWeekdayKst = (ms) => {
            const d = new Date(ms + KST_OFFSET_MS);
            const day = d.getUTCDay(); // 0=일, 6=토 (KST 기준)
            return day >= 1 && day <= 5;
        };

        // start(생성일/마지막 알림일) 다음날부터 end(오늘)까지의 '평일' 개수
        const countWeekdaysSince = (startMs, endMs) => {
            const startDay = toKstMidnightMs(startMs);
            const endDay = toKstMidnightMs(endMs);
            if (endDay <= startDay) return 0;
            let count = 0;
            for (let cur = startDay + MS_PER_DAY; cur <= endDay; cur += MS_PER_DAY) {
                if (isWeekdayKst(cur)) count += 1;
            }
            return count;
        };

        // NOTE(Firestore 인덱스)
        // - where('status','==','pending').where('createdAt','<=',cutoff) 조합은 composite index가 필요합니다.
        // - 인덱스 미구성 시에도 함수가 멈추지 않도록, 여기서는 status로만 조회하고
        //   createdAt 조건은 아래에서 앱 레벨 필터링합니다.
        // - 데이터가 매우 커지면(=pending 문서가 많아지면) 인덱스를 만들고 쿼리로 되돌리는 것을 권장합니다.
        const snapshot = await admin.firestore()
            .collection(COLLECTION_NAME)
            .where("status", "==", "pending")
            .get();

        if (snapshot.empty) {
            console.log("미답변 경과 문의 없음 (pending=0)");
            return null;
        }

        for (const docSnap of snapshot.docs) {
            const data = docSnap.data();

            // ABP로 접수되지 않은 문의는 스킵 (요구사항: ABP 문의함 링크 포함)
            if (!data.abpInquiryId) continue;

            // createdAt이 없으면(구 데이터) 스킵
            if (!data.createdAt || typeof data.createdAt.toMillis !== "function") continue;
            const createdAtMs = data.createdAt.toMillis();
            const weekdayDaysPending = countWeekdaysSince(createdAtMs, now.toMillis());
            if (weekdayDaysPending < WEEKDAY_TARGET_DAYS) continue;

            // 마지막 재알림 이후 '평일 기준 3일' 이내면 스킵 (중복 방지)
            if (data.lastReminderAt) {
                const lastMs = typeof data.lastReminderAt.toMillis === "function"
                    ? data.lastReminderAt.toMillis()
                    : null;
                if (lastMs != null) {
                    const weekdayDaysSinceLast = countWeekdaysSince(lastMs, now.toMillis());
                    if (weekdayDaysSinceLast < WEEKDAY_TARGET_DAYS) continue;
                }
            }

            const teamId = data.abpTargetTeam || data.targetTeam || null;
            const teamLabel = TEAM_LABEL[teamId] || "기획본부";
            const teamSlackId = teamId && TEAM_SLACK_MENTION[teamId];
            const categoryText = getCategoryText(data);
            // 슬랙 표시는 "평일 기준 N일"로 일관되게 표기
            const daysPending = weekdayDaysPending;
            const reminderCount = (data.reminderCount || 0) + 1;

            const manager = await getManagerForBranch(data.branchName, data.manager);
            const managerSlackId = manager?.slackId;
            const managerName = manager?.name || null;

            const content = data.content || "";
            const contentPreview = `${content.slice(0, 300)}${content.length > 300 ? "..." : ""}`;

            const blocks = [
                // 멘션
                ...((teamSlackId || managerSlackId) ? [{
                    type: "section",
                    fields: [
                        teamSlackId ? { type: "mrkdwn", text: `*담당부서*\n<@${teamSlackId}>` } : null,
                        managerSlackId ? { type: "mrkdwn", text: `*지점 담당자*\n<@${managerSlackId}>` } : null,
                    ].filter(Boolean),
                }] : []),
                {
                    type: "header",
                    text: {
                        type: "plain_text",
                        text: `⚠️ 미답변 ${daysPending}일 경과 (${reminderCount}차 알림)`.slice(0, 150),
                    },
                },
                {
                    type: "section",
                    text: {
                        type: "mrkdwn",
                        text: `3일동안 해당 문의가 답변되지 않았어요.\n\n📌 *${categoryText}* | ${data.title || "(제목 없음)"}`,
                    },
                },
                {
                    type: "section",
                    fields: [
                        { type: "mrkdwn", text: `*담당부서*\n${teamLabel}` },
                        { type: "mrkdwn", text: `*지점 담당자*\n${managerName || "-"}` },
                        { type: "mrkdwn", text: `*지점*\n${data.branchName || "-"}` },
                        { type: "mrkdwn", text: `*작성자*\n${data.inquirerName || data.userName || "-"}` },
                    ],
                },
                {
                    type: "section",
                    text: {
                        type: "mrkdwn",
                        text: `*문의내용*\n${contentPreview || "-"}`,
                    },
                },
                // 문의함으로 이동 버튼
                {
                    type: "actions",
                    elements: [{
                        type: "button",
                        style: "danger",
                        text: { type: "plain_text", text: "문의함 가기", emoji: true },
                        url: (teamId === "biz_mk1" || teamId === "biz_mk2")
                            ? `${BASE_URL}/admin?abpOpen=${data.abpInquiryId}`
                            : `${BASE_URL}/abp?open=${data.abpInquiryId}`,
                    }],
                },
                {
                    type: "context",
                    elements: [{
                        type: "mrkdwn",
                        text: `문서 ID: \`${docSnap.id}\` | 재알림: ${new Date().toLocaleString("ko-KR", { timeZone: "Asia/Seoul" })}`,
                    }],
                },
            ];

            try {
                let result;
                const ts = data.slackMessageTs;
                const channelId = data.slackChannelId || SLACK_CHANNEL_ID;

                if (ts && channelId) {
                    // 원본 메시지 thread에 재알림 댓글
                    result = await callSlackApi("chat.postMessage", {
                        channel: channelId,
                        thread_ts: ts,
                        text: `⚠️ 미답변 ${daysPending}일 경과 — ${teamLabel} 확인 필요`,
                        blocks,
                    });
                } else {
                    // 원본 Slack 메시지 없으면 새 메시지
                    result = await postSlackMessage(
                        blocks,
                        `⚠️ 미답변 ${daysPending}일 경과 — ${teamLabel} 확인 필요`
                    );
                }

                if (result && result.ok) {
                    await docSnap.ref.update({
                        lastReminderAt: now,
                        reminderCount: admin.firestore.FieldValue.increment(1),
                    });
                    console.log(`재알림 발송 완료: ${docSnap.id} (${daysPending}일 경과)`);
                } else {
                    console.error(`재알림 Slack 발송 실패: ${docSnap.id}`, result);
                }
            } catch (err) {
                console.error(`재알림 처리 오류: ${docSnap.id}`, err);
            }
        }

        return null;
    });

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
