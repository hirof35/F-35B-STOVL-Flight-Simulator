import * as THREE from 'three';
import { F35BFullSimulator, FlightControls } from './F35BFullSimulator.js';

// --- 1. Three.js の基本セットアップ ---
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x87ceeb); // 青空の色

const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
document.body.appendChild(renderer.domElement);

// 照明の追加
const ambientLight = new THREE.AmbientLight(0xffffff, 0.6);
scene.add(ambientLight);
const dirLight = new THREE.DirectionalLight(0xffffff, 0.8);
dirLight.position.set(10, 20, 10);
scene.add(dirLight);

// 地面の簡易作成（グリッド）
const gridHelper = new THREE.GridHelper(2000, 100, 0x000000, 0x555555);
scene.add(gridHelper);

// --- 2. シミュレーターの生成と配置 ---
const simulator = new F35BFullSimulator();
scene.add(simulator.mesh);

// カメラを機体の後ろに配置（追従用）
camera.position.set(0, 5, 15);

// --- 3. キーボード入力の管理 ---
const controls: FlightControls = {
  throttle: 0.5, // 初期スロットル 50%
  pitch: 0,
  roll: 0,
  yaw: 0,
  conversionButton: false
};

const keys: { [key: string]: boolean } = {};
window.addEventListener('keydown', (e) => { keys[e.key.toLowerCase()] = true; });
window.addEventListener('keyup', (e) => { keys[e.key.toLowerCase()] = false; });

function handleInput() {
  // ピッチ（機首上げ下げ）: W / S
  controls.pitch = keys['w'] ? 1.0 : (keys['s'] ? -1.0 : 0);
  // ロール（左右傾き）: A / D
  controls.roll = keys['a'] ? 1.0 : (keys['d'] ? -1.0 : 0);
  // ヨー（左右旋回）: Q / E
  controls.yaw = keys['q'] ? 1.0 : (keys['e'] ? -1.0 : 0);
  
  // スロットル（出力増減）: Shift / Control
  if (keys['shift']) controls.throttle = Math.min(1.0, controls.throttle + 0.01);
  if (keys['control']) controls.throttle = Math.max(0.0, controls.throttle - 0.01);

  // モード切り替え（Spaceキーを押している間、垂直ホバーへ移行）
  controls.conversionButton = keys[' '];
}

// --- 4. 簡易UI（状態表示用） ---
const ui = document.createElement('div');
ui.style.position = 'absolute';
ui.style.top = '10px';
ui.style.left = '10px';
ui.style.color = 'white';
ui.style.fontFamily = 'monospace';
ui.style.fontSize = '16px';
ui.style.backgroundColor = 'rgba(0,0,0,0.5)';
ui.style.padding = '10px';
ui.style.lineHeight = '1.4';
document.body.appendChild(ui);

// --- 5. メインループ ---
const clock = new THREE.Clock();

function animate() {
  requestAnimationFrame(animate);

  handleInput();

  const dt = clock.getDelta();
  // シミュレーターの物理とビジュアルを更新
  simulator.update(controls, dt);

  // カメラを機体の後方に追従させる
  const relativeCameraOffset = new THREE.Vector3(0, 3, 10);
  const cameraOffset = relativeCameraOffset.applyQuaternion(simulator.rotation);
  camera.position.copy(simulator.position).add(cameraOffset);
  camera.lookAt(simulator.position);

  // UIテキストの更新
  ui.innerHTML = `
    [F-35B Flight Telemetry]<br>
    -------------------------<br>
    MODE: ${simulator.mode}<br>
    NOZZLE ANGLE: ${Math.round(simulator.nozzleAngle)}°<br>
    THROTTLE: ${Math.round(controls.throttle * 100)}%<br>
    ALTITUDE: ${Math.round(simulator.position.y)} m<br>
    SPEED: ${Math.round(-simulator.velocity.clone().applyQuaternion(simulator.rotation.clone().invert()).z * 3.6)} km/h<br>
    GROUND EFFECT: ${simulator.groundEffectForceMagnitude > 0 ? 'ACTIVE' : 'OFF'}<br>
    <span style="color: ${simulator.isStalling ? 'red' : 'lightgreen'}">
      STALL WARNING: ${simulator.isStalling ? 'CRITICAL STALL!!' : 'OK'}
    </span><br>
    -------------------------<br>
    [CONTROLS]<br>
    W/S: Pitch | A/D: Roll | Q/E: Yaw<br>
    Shift: Speed Up | Ctrl: Speed Down<br>
    Space: Hold for STOVL (Hover) Mode
  `;

  renderer.render(scene, camera);
}

// 画面リサイズ対応
window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

animate();