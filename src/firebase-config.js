/* Firebase 콘솔 → 프로젝트 설정 → 내 앱(웹)의 SDK 설정값.
 * (공개되어도 되는 값입니다. 보안은 firestore.rules / database.rules.json 이 담당합니다.)
 *
 *  - apiKey + projectId 가 있으면  → 랭킹을 Firestore 에 저장
 *  - databaseURL 도 있으면         → 방(실시간 대전)을 Realtime Database 로 처리
 *  - 비어 있는 부분은 더미(브라우저 localStorage)로 동작 */
export const firebaseConfig = {
  apiKey: 'AIzaSyDclEOeikXn4-lN8CQNBBSZVvglS3MrNK0',
  authDomain: 'minicar-3d.firebaseapp.com',
  projectId: 'minicar-3d',
  storageBucket: 'minicar-3d.firebasestorage.app',
  messagingSenderId: '52022645012',
  appId: '1:52022645012:web:4318457964c91f4754b201',
  // Realtime Database 를 만든 뒤 콘솔에 표시되는 주소를 넣으세요. 예) https://minicar-3d-default-rtdb.firebaseio.com
  // (아시아 리전이면 https://minicar-3d-default-rtdb.asia-southeast1.firebasedatabase.app)
  databaseURL: 'https://minicar-3d-default-rtdb.firebaseio.com',
};
