// Firebase 설정 (본인의 Firebase 프로젝트 설정으로 변경하세요)
const firebaseConfig = {
    apiKey: "AIzaSyByU5I_IUhwQhEcHKjv0vMasMt-5NAL6lE",
    authDomain: "adotenglish-marketing-cost.firebaseapp.com",
    projectId: "adotenglish-marketing-cost",
    storageBucket: "adotenglish-marketing-cost.firebasestorage.app",
    messagingSenderId: "952480225620",
    appId: "1:952480225620:web:043f9a04065b02f83a10c1",
    measurementId: "G-S9L4NRM0PL"
};

// Firebase 초기화
firebase.initializeApp(firebaseConfig);

// var로 선언하여 전역 스코프에서 접근 가능하도록 함
var auth = firebase.auth();
var db = firebase.firestore();
var storage = firebase.storage();

// ===== ABP 팀 계정(kogrop.co.kr) 설정 =====
const ABP_TEAM_EMAIL_DOMAIN = 'kogrop.co.kr';
const ABP_TEAM_IDS = new Set([
    'biz_mk1',
    'biz_mk2',
    'biz_plan',
    'sales_ops',
    'hrd_academy',
    'eng_lab',
    'content_prod',
    'it_dev',
    'corp_admin'
]);

function parseTeamIdFromEmail(email) {
    if (!email || typeof email !== 'string') return null;
    const parts = email.toLowerCase().split('@');
    if (parts.length !== 2) return null;
    const [local, domain] = parts;
    if (domain !== ABP_TEAM_EMAIL_DOMAIN) return null;
    if (!ABP_TEAM_IDS.has(local)) return null;
    return local;
}

function isAbpTeamEmail(email) {
    return !!parseTeamIdFromEmail(email);
}

// Firebase 오류 메시지 한국어 변환
function getFirebaseErrorMessage(errorCode) {
    const errorMessages = {
        'auth/invalid-email': '유효하지 않은 이메일 형식입니다.',
        'auth/user-disabled': '비활성화된 계정입니다.',
        'auth/user-not-found': '등록되지 않은 이메일입니다.',
        'auth/wrong-password': '비밀번호가 올바르지 않습니다.',
        'auth/too-many-requests': '너무 많은 로그인 시도가 있었습니다. 잠시 후 다시 시도해주세요.',
        'auth/invalid-credential': '이메일 또는 비밀번호가 올바르지 않습니다.',
        'auth/email-already-in-use': '이미 사용 중인 이메일입니다.',
        'auth/weak-password': '비밀번호는 최소 6자 이상이어야 합니다.',
        'auth/network-request-failed': '네트워크 오류가 발생했습니다. 인터넷 연결을 확인해주세요.',
        'auth/requires-recent-login': '보안을 위해 다시 로그인해주세요.'
    };

    return errorMessages[errorCode] || '오류가 발생했습니다. 다시 시도해주세요.';
}

// 이메일/비밀번호 로그인
async function loginWithEmail(email, password) {
    try {
        console.log('🔐 로그인 시도:', email);
        const userCredential = await auth.signInWithEmailAndPassword(email, password);
        const user = userCredential.user;
        console.log('✅ Firebase Auth 로그인 성공:', user.email);

        // ===== 보안: 승인된 계정만 로그인 허용 (관리자/ABP 계정 제외) =====
        // 관리자 및 ABP 계정, ABP 팀 계정은 자동 승인
        if (user.email !== 'admin@dshare.co.kr' && user.email !== 'abp@dshare.co.kr' && !isAbpTeamEmail(user.email)) {
            console.log('🔍 일반 사용자 계정 검증 시작...');
            const validationResult = await validateUserAccount(user);
            if (!validationResult.success) {
                console.error('❌ 계정 검증 실패');
                await auth.signOut(); // 즉시 로그아웃
                return validationResult;
            }
            console.log('✅ 계정 검증 통과');
        } else {
            console.log('✅ 관리자/ABP/ABP팀 계정 - 자동 승인');

            // ABP 팀 계정은 users 문서가 없으면 자동 생성 (승인 체크/lastLogin update를 위해)
            if (isAbpTeamEmail(user.email)) {
                const teamId = parseTeamIdFromEmail(user.email);
                try {
                    const ref = db.collection('users').doc(user.uid);
                    const doc = await ref.get();
                    if (!doc.exists) {
                        await ref.set({
                            uid: user.uid,
                            email: user.email,
                            isActive: true,
                            role: 'abp_team',
                            abpTeamId: teamId,
                            createdAt: firebase.firestore.FieldValue.serverTimestamp()
                        });
                    } else {
                        // 최소한 이메일 불일치로 막히지 않도록 유지
                        await ref.set(
                            {
                                email: user.email,
                                isActive: doc.data()?.isActive === false ? false : true,
                                role: doc.data()?.role || 'abp_team',
                                abpTeamId: doc.data()?.abpTeamId || teamId
                            },
                            { merge: true }
                        );
                    }
                } catch (e) {
                    console.error('ABP 팀 users 문서 생성/갱신 실패:', e);
                    // 여기서 로그인 자체를 막지는 않음 (페이지 가드에서 다시 처리 가능)
                }
            }
        }
        // ===== 보안 확인 끝 =====

        // 마지막 로그인 시간 업데이트
        await updateLastLogin(user.uid);

        console.log('🎉 로그인 완료:', user.email);
        return { success: true, user: user };
    } catch (error) {
        console.error('❌ 로그인 오류:', error);
        return { success: false, error: error.code, message: getFirebaseErrorMessage(error.code) };
    }
}

// ===== 보안: 계정 검증 함수 =====
// Firestore에 등록된 승인된 계정인지 확인 (자동 생성하지 않음!)
async function validateUserAccount(user) {
    try {
        const doc = await db.collection('users').doc(user.uid).get();

        if (!doc.exists) {
            // ⚠️ 보안: Firestore에 사용자 정보가 없으면 미승인 계정
            console.error('🚨 미승인 계정 로그인 차단:', user.email);
            return {
                success: false,
                message: '관리자가 승인하지 않은 계정입니다.\n계정 생성은 관리자에게 문의하세요.\n담당자: 학원사업마케팅팀 / 박영주'
            };
        }

        const userData = doc.data();

        // 비활성화된 계정 확인
        if (userData.isActive === false) {
            console.error('🚨 비활성화된 계정 로그인 차단:', user.email);
            return {
                success: false,
                message: '비활성화된 계정입니다.\n관리자에게 문의하세요.'
            };
        }

        // ===== 보안: 이메일 불일치 감지 (이메일 변조 차단) =====
        if (userData.email !== user.email) {
            console.error('🚨 이메일 불일치 감지! Auth:', user.email, '/ Firestore:', userData.email);
            console.error('🚨 계정 변조 시도 차단 - uid:', user.uid);
            return {
                success: false,
                message: '계정 정보가 변조되었습니다.\n보안을 위해 로그인이 차단되었습니다.\n관리자에게 문의하세요.\n담당자: 박영주 / 010-4037-0928'
            };
        }

        console.log('✅ 승인된 계정 로그인:', user.email);
        return { success: true };
    } catch (error) {
        console.error('사용자 정보 확인 오류:', error);
        return {
            success: false,
            message: '사용자 정보를 확인할 수 없습니다.\n관리자에게 문의하세요.'
        };
    }
}

// Firestore에 사용자 정보가 없으면 생성 (관리자만 사용, 일반 로그인에서는 호출하지 않음)
async function ensureUserInFirestore(user) {
    try {
        const doc = await db.collection('users').doc(user.uid).get();

        if (!doc.exists) {
            // 관리자 계정만 자동 생성 허용
            if (user.email === 'admin@dshare.co.kr' || user.email === 'abp@dshare.co.kr') {
                await db.collection('users').doc(user.uid).set({
                    uid: user.uid,
                    email: user.email,
                    displayName: user.displayName || user.email.split('@')[0],
                    branchName: '',
                    role: user.email === 'admin@dshare.co.kr' ? 'admin' : 'abp',
                    createdAt: firebase.firestore.FieldValue.serverTimestamp(),
                    lastLoginAt: firebase.firestore.FieldValue.serverTimestamp(),
                    isActive: true,
                    marketingPassword: '0000'
                });
                console.log('관리자 계정 정보가 Firestore에 생성되었습니다.');
            } else {
                console.error('일반 계정은 자동 생성할 수 없습니다:', user.email);
                return { success: false };
            }
        } else {
            // 사용자 정보가 있으면 마지막 로그인 시간만 업데이트
            await db.collection('users').doc(user.uid).update({
                lastLoginAt: firebase.firestore.FieldValue.serverTimestamp()
            });
        }
        return { success: true };
    } catch (error) {
        console.error('Firestore 사용자 정보 처리 오류:', error);
        return { success: false };
    }
}

// 로그아웃
async function logout() {
    try {
        await auth.signOut();
        return { success: true };
    } catch (error) {
        console.error('로그아웃 오류:', error);
        return { success: false, error: error.code, message: getFirebaseErrorMessage(error.code) };
    }
}

// 현재 로그인된 사용자 가져오기
function getCurrentUser() {
    return auth.currentUser;
}

// 인증 상태 변경 리스너
function onAuthStateChange(callback) {
    return auth.onAuthStateChanged(callback);
}

// ===== 보안: 이메일 변조 실시간 감시 =====
// 페이지에서 호출하여 이메일 변경을 실시간으로 감지하고 차단
async function monitorEmailChanges() {
    if (!auth.currentUser) return true;

    const currentUser = auth.currentUser;
    const uid = currentUser.uid;

    // 관리자 및 ABP 계정은 감시 제외
    if (currentUser.email === 'admin@dshare.co.kr' || currentUser.email === 'abp@dshare.co.kr') {
        return true;
    }

    try {
        const doc = await db.collection('users').doc(uid).get();

        if (doc.exists) {
            const userData = doc.data();
            const authEmail = currentUser.email;
            const firestoreEmail = userData.email;

            // 이메일 불일치 감지
            if (authEmail !== firestoreEmail) {
                console.error('🚨🚨🚨 실시간 이메일 변조 감지!');
                console.error('Auth Email:', authEmail);
                console.error('Firestore Email:', firestoreEmail);
                console.error('계정을 강제 로그아웃합니다.');

                alert('⚠️ 계정 정보 변조가 감지되었습니다.\n보안을 위해 로그아웃됩니다.\n\n정상적인 접근을 원하시면 관리자에게 문의하세요.\n담당자: 박영주 / 010-4037-0928');

                await auth.signOut();
                window.location.href = 'index.html';
                return false;
            }

            return true;
        }
    } catch (error) {
        console.error('이메일 검증 오류:', error);
    }

    return true;
}

// 페이지에서 주기적으로 이메일 검증 (30초마다)
function startEmailMonitoring() {
    // 즉시 한 번 체크
    monitorEmailChanges();

    // 30초마다 체크
    return setInterval(() => {
        monitorEmailChanges();
    }, 30000); // 30초
}

// ⚠️ 사용자 생성 함수 - 보안상 비활성화 (관리자만 admin.html에서 createUserByAdmin 사용)
// 이 함수는 외부에서 호출되지 않도록 합니다
async function createUser(email, password, displayName = '', branchName = '') {
    console.error('🚨 보안: createUser 함수는 비활성화되었습니다. 관리자를 통해 계정을 생성하세요.');
    console.error('담당자: 학원사업마케팅팀 박영주');
    return {
        success: false,
        message: '보안상 일반 회원가입은 차단되었습니다.\n관리자에게 계정 생성을 요청하세요.\n담당자: 박영주 / 010-4037-0928'
    };

    // 아래 코드는 실행되지 않음 (보안상 주석 처리하지 않고 막음)
    /*
    try {
        const userCredential = await auth.createUserWithEmailAndPassword(email, password);
        const user = userCredential.user;

        // Firestore에 사용자 정보 저장
        await db.collection('users').doc(user.uid).set({
            uid: user.uid,
            email: email,
            displayName: displayName || email.split('@')[0],
            branchName: branchName,
            role: email === 'admin@dshare.co.kr' ? 'admin' : 'user',
            createdAt: firebase.firestore.FieldValue.serverTimestamp(),
            lastLoginAt: firebase.firestore.FieldValue.serverTimestamp(),
            isActive: true
        });

        return { success: true, user: user };
    } catch (error) {
        console.error('회원가입 오류:', error);
        return { success: false, error: error.code, message: getFirebaseErrorMessage(error.code) };
    }
    */
}

// 관리자용 사용자 생성 (Firebase Functions 사용)
async function createUserByAdmin(newUserEmail, newUserPassword, adminEmail, uniquePassword, displayName = '', branchName = '', team = '', manager = '') {
    try {
        // 1. 관리자로 로그인되어 있는지 확인
        const adminUser = auth.currentUser;
        if (!adminUser || adminUser.email !== adminEmail) {
            return { success: false, message: '관리자로 로그인되어 있지 않습니다.' };
        }

        // 2. Firebase Functions 호출
        const functions = firebase.app().functions();
        const createUserFunction = functions.httpsCallable('createUser');

        const result = await createUserFunction({
            email: newUserEmail,
            password: newUserPassword,
            displayName: displayName,
            branchName: branchName,
            team: team,
            manager: manager,
            uniquePassword: uniquePassword
        });

        if (result.data && result.data.success) {
            console.log('✅ 새 사용자 생성 완료 (Functions):', newUserEmail);
            return {
                success: true,
                user: {
                    uid: result.data.uid,
                    email: result.data.email
                }
            };
        } else {
            return {
                success: false,
                message: result.data?.message || '사용자 생성에 실패했습니다.'
            };
        }
    } catch (error) {
        console.error('❌ 관리자 사용자 생성 오류:', error);

        let errorMessage = '사용자 생성에 실패했습니다.';

        if (error.code === 'functions/not-found') {
            errorMessage = 'Firebase Functions가 배포되지 않았습니다. 관리자에게 문의하세요.';
        } else if (error.message) {
            errorMessage = error.message;
        }

        return {
            success: false,
            error: error.code,
            message: errorMessage
        };
    }
}

// 비밀번호 재설정 이메일 발송
async function sendPasswordReset(email) {
    try {
        await auth.sendPasswordResetEmail(email);
        return { success: true };
    } catch (error) {
        console.error('비밀번호 재설정 오류:', error);
        return { success: false, error: error.code, message: getFirebaseErrorMessage(error.code) };
    }
}

// ===== Firestore 사용자 관리 함수 =====

// 모든 사용자 목록 가져오기
async function getAllUsers() {
    try {
        // orderBy 없이 먼저 시도 (인덱스 문제 방지)
        const snapshot = await db.collection('users').get();
        const users = [];
        snapshot.forEach(doc => {
            users.push({ id: doc.id, ...doc.data() });
        });

        // 클라이언트에서 정렬 (createdAt 기준 내림차순)
        users.sort((a, b) => {
            const dateA = a.createdAt?.toDate?.() || new Date(0);
            const dateB = b.createdAt?.toDate?.() || new Date(0);
            return dateB - dateA;
        });

        console.log('사용자 목록 조회 성공:', users.length + '명');
        return { success: true, users: users };
    } catch (error) {
        console.error('사용자 목록 조회 오류:', error);
        console.error('오류 코드:', error.code);
        console.error('오류 메시지:', error.message);
        return { success: false, error: error.code, message: '사용자 목록을 불러오는데 실패했습니다. 오류: ' + error.message };
    }
}

// 사용자 정보 업데이트
async function updateUser(uid, data) {
    try {
        await db.collection('users').doc(uid).update({
            ...data,
            updatedAt: firebase.firestore.FieldValue.serverTimestamp()
        });
        return { success: true };
    } catch (error) {
        console.error('사용자 정보 업데이트 오류:', error);
        return { success: false, error: error.code, message: '사용자 정보 업데이트에 실패했습니다.' };
    }
}

// 사용자 활성화/비활성화
async function toggleUserActive(uid, isActive) {
    try {
        await db.collection('users').doc(uid).update({
            isActive: isActive,
            updatedAt: firebase.firestore.FieldValue.serverTimestamp()
        });
        return { success: true };
    } catch (error) {
        console.error('사용자 상태 변경 오류:', error);
        return { success: false, error: error.code, message: '사용자 상태 변경에 실패했습니다.' };
    }
}

// 사용자 삭제 (Firestore에서만 - Auth는 Admin SDK 필요)
async function deleteUserFromFirestore(uid) {
    try {
        await db.collection('users').doc(uid).delete();
        return { success: true };
    } catch (error) {
        console.error('사용자 삭제 오류:', error);
        return { success: false, error: error.code, message: '사용자 삭제에 실패했습니다.' };
    }
}

// 현재 사용자 정보를 Firestore에서 가져오기
async function getCurrentUserData(uid) {
    try {
        const doc = await db.collection('users').doc(uid).get();
        if (doc.exists) {
            return { success: true, data: doc.data() };
        } else {
            return { success: false, message: '사용자 정보를 찾을 수 없습니다.' };
        }
    } catch (error) {
        console.error('사용자 정보 조회 오류:', error);
        return { success: false, error: error.code, message: '사용자 정보를 불러오는데 실패했습니다.' };
    }
}

// 로그인 시 마지막 로그인 시간 업데이트
async function updateLastLogin(uid) {
    try {
        await db.collection('users').doc(uid).update({
            lastLoginAt: firebase.firestore.FieldValue.serverTimestamp()
        });
        return { success: true };
    } catch (error) {
        console.error('마지막 로그인 시간 업데이트 오류:', error);
        return { success: false };
    }
}

// ===== 자동 로그아웃 기능 =====

// 자동 로그아웃 시간 (밀리초) - 6시간
const AUTO_LOGOUT_TIME = 6 * 60 * 60 * 1000; // 6시간

// 마지막 활동 시간 업데이트
function updateLastActivity() {
    if (auth.currentUser) {
        localStorage.setItem('lastActivityTime', Date.now().toString());
    }
}

// 자동 로그아웃 체크
function checkAutoLogout() {
    if (!auth.currentUser) return true;

    const lastActivity = localStorage.getItem('lastActivityTime');

    if (lastActivity) {
        const timePassed = Date.now() - parseInt(lastActivity);

        // 1일이 지났으면 자동 로그아웃
        if (timePassed > AUTO_LOGOUT_TIME) {
            console.log('자동 로그아웃: 24시간 동안 활동 없음');
            auth.signOut().then(() => {
                localStorage.removeItem('lastActivityTime');
                alert('보안을 위해 자동 로그아웃되었습니다.\n(24시간 동안 활동 없음)\n\n다시 로그인해주세요.');
                window.location.href = 'index.html';
            });
            return false;
        }
    } else {
        // 첫 로그인 또는 활동 시간 없음
        updateLastActivity();
    }

    return true;
}

// 인증 상태 변경 시 체크
auth.onAuthStateChanged((user) => {
    if (user) {
        // 로그인 상태면 체크
        checkAutoLogout();
    } else {
        // 로그아웃 시 활동 시간 삭제
        localStorage.removeItem('lastActivityTime');
    }
});

// 사용자 활동 감지 시 시간 업데이트
if (typeof document !== 'undefined') {
    document.addEventListener('click', updateLastActivity);
    document.addEventListener('keydown', updateLastActivity);
    document.addEventListener('scroll', updateLastActivity);
    document.addEventListener('mousemove', updateLastActivity);
}

// 1분마다 자동 로그아웃 체크
setInterval(checkAutoLogout, 60000); // 1분

// ===== Firebase Storage 이미지 관리 함수 =====

// 이미지 크기 제한 상수
const MAX_IMAGE_WIDTH = 3500;
const MAX_IMAGE_HEIGHT = 3500;

// 이미지 크기(픽셀) 검증 함수
function validateImageDimensions(file) {
    return new Promise((resolve) => {
        const img = new Image();
        const objectUrl = URL.createObjectURL(file);

        img.onload = () => {
            URL.revokeObjectURL(objectUrl);

            if (img.width > MAX_IMAGE_WIDTH || img.height > MAX_IMAGE_HEIGHT) {
                resolve({
                    valid: false,
                    message: `이미지 크기가 너무 큽니다. 최대 ${MAX_IMAGE_WIDTH} x ${MAX_IMAGE_HEIGHT} 픽셀까지 허용됩니다. (현재: ${img.width} x ${img.height})`,
                    width: img.width,
                    height: img.height
                });
            } else {
                resolve({
                    valid: true,
                    width: img.width,
                    height: img.height
                });
            }
        };

        img.onerror = () => {
            URL.revokeObjectURL(objectUrl);
            resolve({ valid: false, message: '이미지 파일을 읽을 수 없습니다.' });
        };

        img.src = objectUrl;
    });
}

// 이미지 업로드 (단일 파일)
async function uploadImage(file, userId, costId) {
    try {
        // 파일 타입 검증
        if (!file.type.match('image/(jpeg|png)')) {
            return { success: false, message: 'JPG 또는 PNG 파일만 업로드 가능합니다.' };
        }

        // 이미지 크기(픽셀) 검증
        const dimensionCheck = await validateImageDimensions(file);
        if (!dimensionCheck.valid) {
            return { success: false, message: dimensionCheck.message };
        }

        // 고유한 파일명 생성
        const timestamp = Date.now();
        const fileName = `${timestamp}_${file.name}`;
        const filePath = `costs/${userId}/${costId}/${fileName}`;

        // Storage에 업로드
        const storageRef = storage.ref(filePath);
        const uploadTask = await storageRef.put(file);

        // 다운로드 URL 가져오기
        const downloadURL = await uploadTask.ref.getDownloadURL();

        return {
            success: true,
            url: downloadURL,
            path: filePath,
            fileName: fileName
        };
    } catch (error) {
        console.error('이미지 업로드 오류:', error);
        return { success: false, message: '이미지 업로드에 실패했습니다: ' + error.message };
    }
}

// 여러 이미지 업로드
async function uploadImages(files, userId, costId) {
    try {
        const uploadResults = [];

        for (const file of files) {
            const result = await uploadImage(file, userId, costId);
            if (result.success) {
                uploadResults.push({
                    url: result.url,
                    path: result.path,
                    fileName: result.fileName
                });
            } else {
                console.error('개별 이미지 업로드 실패:', file.name, result.message);
            }
        }

        return {
            success: true,
            images: uploadResults,
            uploadedCount: uploadResults.length,
            totalCount: files.length
        };
    } catch (error) {
        console.error('다중 이미지 업로드 오류:', error);
        return { success: false, message: '이미지 업로드에 실패했습니다.' };
    }
}

// 이미지 삭제 (단일)
async function deleteImage(filePath) {
    try {
        const storageRef = storage.ref(filePath);
        await storageRef.delete();
        return { success: true };
    } catch (error) {
        console.error('이미지 삭제 오류:', error);
        // 파일이 이미 없는 경우도 성공으로 처리
        if (error.code === 'storage/object-not-found') {
            return { success: true };
        }
        return { success: false, message: '이미지 삭제에 실패했습니다.' };
    }
}

// 여러 이미지 삭제
async function deleteImages(filePaths) {
    try {
        const deletePromises = filePaths.map(path => deleteImage(path));
        await Promise.all(deletePromises);
        return { success: true };
    } catch (error) {
        console.error('다중 이미지 삭제 오류:', error);
        return { success: false, message: '일부 이미지 삭제에 실패했습니다.' };
    }
}

// 비용에 연결된 모든 이미지 삭제 (폴더 삭제)
async function deleteCostImages(userId, costId) {
    try {
        const folderRef = storage.ref(`costs/${userId}/${costId}`);
        const listResult = await folderRef.listAll();

        const deletePromises = listResult.items.map(item => item.delete());
        await Promise.all(deletePromises);

        return { success: true };
    } catch (error) {
        console.error('비용 이미지 폴더 삭제 오류:', error);
        // 폴더가 비어있거나 없는 경우도 성공으로 처리
        if (error.code === 'storage/object-not-found') {
            return { success: true };
        }
        return { success: false, message: '이미지 삭제에 실패했습니다.' };
    }
}

// ===== 보안: 전역 함수로 노출 (HTML에서 사용) =====
window.startEmailMonitoring = startEmailMonitoring;
window.monitorEmailChanges = monitorEmailChanges;
