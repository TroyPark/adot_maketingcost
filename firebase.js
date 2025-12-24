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
        const userCredential = await auth.signInWithEmailAndPassword(email, password);
        const user = userCredential.user;
        
        // Firestore에 사용자 정보가 없으면 생성, 있으면 마지막 로그인 시간 업데이트
        await ensureUserInFirestore(user);
        
        return { success: true, user: user };
    } catch (error) {
        console.error('로그인 오류:', error);
        return { success: false, error: error.code, message: getFirebaseErrorMessage(error.code) };
    }
}

// Firestore에 사용자 정보가 없으면 생성
async function ensureUserInFirestore(user) {
    try {
        const doc = await db.collection('users').doc(user.uid).get();
        
        if (!doc.exists) {
            // 사용자 정보가 없으면 새로 생성
            await db.collection('users').doc(user.uid).set({
                uid: user.uid,
                email: user.email,
                displayName: user.displayName || user.email.split('@')[0],
                branchName: '',
                role: user.email === 'admin@dshare.co.kr' ? 'admin' : 'user',
                createdAt: firebase.firestore.FieldValue.serverTimestamp(),
                lastLoginAt: firebase.firestore.FieldValue.serverTimestamp(),
                isActive: true
            });
            console.log('새 사용자 정보가 Firestore에 생성되었습니다.');
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

// 사용자 생성 (회원가입) - Firestore에도 저장
async function createUser(email, password, displayName = '', branchName = '') {
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
}

// 관리자용 사용자 생성 (생성 후 관리자로 다시 로그인)
async function createUserByAdmin(newUserEmail, newUserPassword, adminEmail, adminPassword, displayName = '', branchName = '') {
    try {
        // 1. 먼저 관리자 비밀번호가 맞는지 확인 (현재 관리자 세션 유지하면서)
        const adminUser = auth.currentUser;
        if (!adminUser || adminUser.email !== adminEmail) {
            return { success: false, message: '관리자로 로그인되어 있지 않습니다.' };
        }

        // 2. 관리자 재인증으로 비밀번호 확인
        const credential = firebase.auth.EmailAuthProvider.credential(adminEmail, adminPassword);
        try {
            await adminUser.reauthenticateWithCredential(credential);
        } catch (authError) {
            console.error('관리자 인증 실패:', authError);
            return { success: false, message: '관리자 비밀번호가 올바르지 않습니다.' };
        }

        // 3. 새 사용자 생성 (이때 새 사용자로 자동 로그인됨)
        const userCredential = await auth.createUserWithEmailAndPassword(newUserEmail, newUserPassword);
        const newUser = userCredential.user;
        
        // 4. Firestore에 사용자 정보 저장
        await db.collection('users').doc(newUser.uid).set({
            uid: newUser.uid,
            email: newUserEmail,
            displayName: displayName || newUserEmail.split('@')[0],
            branchName: branchName,
            role: 'user',
            createdAt: firebase.firestore.FieldValue.serverTimestamp(),
            lastLoginAt: null,
            isActive: true
        });
        
        // 5. 관리자 계정으로 다시 로그인
        await auth.signInWithEmailAndPassword(adminEmail, adminPassword);
        
        console.log('새 사용자 생성 완료:', newUserEmail);
        return { success: true, user: newUser };
    } catch (error) {
        console.error('관리자 사용자 생성 오류:', error);
        
        // 오류 발생 시 관리자로 다시 로그인 시도
        try {
            await auth.signInWithEmailAndPassword(adminEmail, adminPassword);
        } catch (reloginError) {
            console.error('관리자 재로그인 실패:', reloginError);
        }
        
        return { success: false, error: error.code, message: getFirebaseErrorMessage(error.code) };
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

