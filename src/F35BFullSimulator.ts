import * as THREE from 'three';

// 飛行モードの型定義
export type FlightMode = 'CONVENTIONAL' | 'HOVER' | 'TRANSITION';

// 操縦入力インターフェース
export interface FlightControls {
  throttle: number;         // 0.0 ~ 1.0 (出力)
  pitch: number;            // -1.0 ~ 1.0 (昇降舵 / 機首上げ・下げ)
  roll: number;             // -1.0 ~ 1.0 (補助翼 / 左右傾き)
  yaw: number;              // -1.0 ~ 1.0 (方向舵 / 左右旋回)
  conversionButton: boolean; // true: ホバーモードへ移行, false: 通常モードへ移行
}

export class F35BFullSimulator {
  // --- 物理状態（世界座標系） ---
  public position = new THREE.Vector3(0, 100, 0); // 初期高度 100m
  public velocity = new THREE.Vector3(0, 0, -50); // 初期前進速度 50m/s
  public rotation = new THREE.Quaternion();

  // --- F-35B 特有のステート ---
  public mode: FlightMode = 'CONVENTIONAL';
  public nozzleAngle = 0;      // 0度（真後ろ）〜 90度（真下）
  public isStalling = false;   // ストール（失速）フラグ
  public groundEffectForceMagnitude = 0; // 画面UI表示用（地面効果の強さ）

  // --- 3Dビジュアルコンポーネント ---
  public mesh: THREE.Group;                  // 機体全体の親メッシュ
  private nozzleBase = new THREE.Group();    // ノズル根元（セグメント1）
  private nozzleMid = new THREE.Group();     // ノズル中間（セグメント2）
  private nozzleTip = new THREE.Group();     // ノズル先端（セグメント3）
  private afterburnerEffect!: THREE.Mesh;    // バーナー炎エフェクト

  // --- 物理定数 ---
  private readonly GRAVITY = 9.81;
  private readonly MASS = 18000;             // 機体重量 (kg)
  private readonly MAX_THRUST = 191000;       // メインエンジン最大推力 (N)
  private readonly CRITICAL_SPEED = 41.6;    // 失速臨界速度: 約150km/h (m/s)
  private readonly WING_AREA = 42;           // 主翼面積 (m2)

  constructor() {
    // 3Dモデル全体のルートを作成
    this.mesh = new THREE.Group();
    
    // 簡易的な機体本体の生成（仮の箱）
    this.createJetBody();
    // 推力偏向ノズルの生成と階層化
    this.createNozzleVisual();
  }

  /**
   * 毎フレーム呼び出すメイン更新関数
   * @param controls プレイヤーの入力
   * @param dt 前フレームからの経過時間（秒）
   */
  public update(controls: FlightControls, dt: number) {
    // 1. F-35B特有のノズル変形・モードの更新
    this.updateFlightMode(controls.conversionButton, dt);

    // 2. ローカル速度の計算（空力計算用）
    const localVelocity = this.velocity.clone().applyQuaternion(this.rotation.clone().invert());

    // 3. 各種の力（Force）を算出
    const totalForce = new THREE.Vector3(0, 0, 0);

    // (A) 重力
    const gravityForce = new THREE.Vector3(0, -this.GRAVITY * this.MASS, 0);
    totalForce.add(gravityForce);

    // (B) メイン推力とリフトファン推力
    const currentThrustMagnitude = controls.throttle * this.MAX_THRUST;
    const thrustForce = this.calculateThrustForces(currentThrustMagnitude);
    totalForce.add(thrustForce);

    // (C) 空力（揚力・抗力）および ストール判定
    const aeroForce = this.calculateAerodynamics(localVelocity);
    totalForce.add(aeroForce);

    // (D) 地面効果（グラウンドエフェクト）
    // 地面（高度0）からの距離で判定
    this.groundEffectForceMagnitude = this.calculateGroundEffect(this.position.y, currentThrustMagnitude);
    if (this.groundEffectForceMagnitude > 0 && this.nozzleAngle > 45) {
      // 垂直ノズルが下を向いている時、機体のローカル上方向にクッションが働く
      const geForce = new THREE.Vector3(0, this.groundEffectForceMagnitude, 0).applyQuaternion(this.rotation);
      totalForce.add(geForce);
    }

    // 4. 物理運動方程式の適用 (加速度 -> 速度 -> 位置)
    const acceleration = totalForce.divideScalar(this.MASS);
    this.velocity.addScaledVector(acceleration, dt);
    this.position.addScaledVector(this.velocity, dt);

    // 最低高度（地面）の制限
    if (this.position.y < 0) {
      this.position.y = 0;
      this.velocity.set(0, 0, 0); // 簡易着陸（衝突判定は省略）
    }

    // 5. 姿勢（回転）の更新
    this.updateRotation(controls, dt);

    // 6. 3Dビジュアルへの同期
    this.syncVisuals(controls.throttle);
  }

  /**
   * ノズル角度と飛行モードの遷移ロジック
   */
  private updateFlightMode(conversionButton: boolean, dt: number) {
    const CONVERSION_SPEED = 18; // 1秒間に変化するノズル角度（約5秒で全開）

    if (conversionButton) {
      this.nozzleAngle = Math.min(90, this.nozzleAngle + CONVERSION_SPEED * dt);
    } else {
      this.nozzleAngle = Math.max(0, this.nozzleAngle - CONVERSION_SPEED * dt);
    }

    if (this.nozzleAngle === 0) this.mode = 'CONVENTIONAL';
    else if (this.nozzleAngle === 90) this.mode = 'HOVER';
    else this.mode = 'TRANSITION';
  }

  /**
   * ノズル角度に応じた推力ベクトルの計算
   */
  private calculateThrustForces(currentThrustMagnitude: number): THREE.Vector3 {
    const totalThrust = new THREE.Vector3(0, 0, 0);

    // 1. メインノズル推力方向（ローカル座標系）
    const thrustDirection = new THREE.Vector3(0, 0, -1); // デフォルトは後方噴射
    const nozzleRad = (this.nozzleAngle * Math.PI) / 180;
    thrustDirection.applyAxisAngle(new THREE.Vector3(1, 0, 0), nozzleRad); // X軸中心に下へ曲げる

    const mainThrustForce = thrustDirection.multiplyScalar(currentThrustMagnitude);
    totalThrust.add(mainThrustForce);

    // 2. F-35B 特有のリフトファン推力 (ノズル角度が30度以上でブレード展開)
    if (this.nozzleAngle > 30) {
      // 最大で総出力の約40%がコックピット後方のファンから真下に噴射される
      const liftFanRatio = (this.nozzleAngle / 90) * 0.4;
      const liftFanForce = new THREE.Vector3(0, currentThrustMagnitude * liftFanRatio, 0);
      totalThrust.add(liftFanForce);
    }

    // ローカルの総推力を世界座標系へ変換
    return totalThrust.applyQuaternion(this.rotation);
  }

  /**
   * 揚力・抗力・失速（ストール）の計算
   */
  private calculateAerodynamics(localVelocity: THREE.Vector3): THREE.Vector3 {
    const aeroForce = new THREE.Vector3(0, 0, 0);
    const conventionalRatio = 1.0 - (this.nozzleAngle / 90);

    if (conventionalRatio <= 0.05) return aeroForce; // 完全ホバー時は空力を無視

    const forwardSpeed = -localVelocity.z; // ローカル-Zが前進

    // 迎角（AoA）の簡易算出
    let aoa = 0;
    if (forwardSpeed > 5) {
      aoa = Math.atan2(localVelocity.y, forwardSpeed);
    }

    // 揚力係数 (Cl)
    let cl = 2 * Math.PI * aoa;

    // ストール判定 (速度150km/h以下、または機首の上げすぎ18度以上)
    const isSpeedStall = forwardSpeed < this.CRITICAL_SPEED;
    const isAoAStall = Math.abs(aoa) > 0.31; // 0.31rad ≒ 18deg

    if (isSpeedStall || isAoAStall) {
      this.isStalling = true;
      cl *= 0.15; // 揚力が15%まで激減
    } else {
      this.isStalling = false;
    }

    // 揚力計算
    const speedSquared = Math.pow(Math.max(0, forwardSpeed), 2);
    const liftMagnitude = 0.5 * 1.225 * speedSquared * this.WING_AREA * cl * conventionalRatio;
    aeroForce.y = liftMagnitude;

    // 抗力（空気抵抗）計算
    const cd = 0.03 + (this.isStalling ? 0.5 : Math.pow(cl, 2) * 0.1);
    const dragMagnitude = 0.5 * 1.225 * speedSquared * this.WING_AREA * cd * conventionalRatio;
    aeroForce.z = dragMagnitude; // プラス方向（後ろ向きの抵抗）

    // ローカル空力を世界座標系へ変換
    return aeroForce.applyQuaternion(this.rotation);
  }

  /**
   * 地面効果（グラウンドエフェクト）の計算
   */
  private calculateGroundEffect(altitude: number, currentThrust: number): number {
    const EFFECT_START_ALTITUDE = 12.0; // 12メートル以下で効果発動
    const MAX_BOOST_MULTIPLIER = 0.20;   // 地面密着時に最大20%推力上昇

    if (altitude <= 0.1 || altitude >= EFFECT_START_ALTITUDE) return 0;

    const factor = 1.0 - (altitude / EFFECT_START_ALTITUDE);
    const exponentialFactor = Math.pow(factor, 2); // 地面直前でクッションが急激に硬くなる

    return currentThrust * MAX_BOOST_MULTIPLIER * exponentialFactor;
  }

  /**
   * 操縦桿入力による姿勢（回転）制御
   */
  private updateRotation(controls: FlightControls, dt: number) {
    // ホバー時は空力舵面が効かないためRCS制御（レスポンスが少し落ちる挙動を再現）
    const ctrlEfficiency = this.mode === 'HOVER' ? 0.4 : (this.isStalling ? 0.2 : 1.0);

    const pitchSpeed = controls.pitch * 1.8 * ctrlEfficiency * dt;
    const rollSpeed = -controls.roll * 2.5 * ctrlEfficiency * dt;
    const yawSpeed = -controls.yaw * 0.8 * dt;

    const deltaRotation = new THREE.Quaternion().setFromEuler(
      new THREE.Euler(pitchSpeed, yawSpeed, rollSpeed, 'YXZ')
    );
    this.rotation.multiply(deltaRotation).normalize();
  }

  /**
   * 物理データ（位置・回転・ノズル角）をThree.jsのコンポーネントに同期
   */
  private syncVisuals(throttle: number) {
    // 1. 機体本体の位置と回転を反映
    this.mesh.position.copy(this.position);
    this.mesh.quaternion.copy(this.rotation);

    // 2. 3軸推力偏向ノズルの折れ曲がりアニメーション
    const targetRad = (this.nozzleAngle * Math.PI) / 180;
    const anglePerSegment = targetRad / 3; // 3つの関節に均等分配

    this.nozzleBase.rotation.x = anglePerSegment;
    this.nozzleMid.rotation.x = anglePerSegment;
    this.nozzleTip.rotation.x = anglePerSegment;

    // 3. アフターバーナー（ジェット炎）のスケール連動
    if (this.afterburnerEffect) {
      this.afterburnerEffect.scale.z = throttle * 2.0;
      // スロットルがゼロに近い時は非表示
      this.afterburnerEffect.visible = throttle > 0.05;
    }
  }

  // --- メッシュ生成用ヘルパーメソッド ---
  
  private createJetBody() {
    const bodyMat = new THREE.MeshStandardMaterial({ color: 0x4f5d65, roughness: 0.4 });
    
    // 簡易的な胴体
    const bodyGeo = new THREE.ConeGeometry(1, 6, 4);
    bodyGeo.rotateX(Math.PI / 2); // 前後を向かせる
    const bodyMesh = new THREE.Mesh(bodyGeo, bodyMat);
    this.mesh.add(bodyMesh);

    // 簡易的な主翼
    const wingGeo = new THREE.BoxGeometry(7, 0.1, 2);
    const wingMesh = new THREE.Mesh(wingGeo, bodyMat);
    wingMesh.position.set(0, 0, 0);
    this.mesh.add(wingMesh);
  }

  private createNozzleVisual() {
    const nozzleMat = new THREE.MeshStandardMaterial({ color: 0x222222, metalness: 0.7, roughness: 0.3 });

    // セグメント1 (根元)
    const geo1 = new THREE.CylinderGeometry(0.5, 0.5, 0.6, 16);
    geo1.rotateX(Math.PI / 2);
    const mesh1 = new THREE.Mesh(geo1, nozzleMat);
    mesh1.position.set(0, 0, -0.3);
    this.nozzleBase.add(mesh1);
    this.nozzleBase.position.set(0, 0, -3.0); // 機体後方に配置
    this.mesh.add(this.nozzleBase);

    // セグメント2 (中間)
    const geo2 = new THREE.CylinderGeometry(0.48, 0.48, 0.6, 16);
    geo2.rotateX(Math.PI / 2);
    const mesh2 = new THREE.Mesh(geo2, nozzleMat);
    mesh2.position.set(0, 0, -0.3);
    this.nozzleMid.add(mesh2);
    this.nozzleMid.position.set(0, 0, -0.6);
    this.nozzleBase.add(this.nozzleMid);

    // セグメント3 (先端)
    const geo3 = new THREE.CylinderGeometry(0.42, 0.45, 0.5, 16);
    geo3.rotateX(Math.PI / 2);
    const mesh3 = new THREE.Mesh(geo3, nozzleMat);
    mesh3.position.set(0, 0, -0.25);
    this.nozzleTip.add(mesh3);
    this.nozzleTip.position.set(0, 0, -0.6);
    this.nozzleMid.add(this.nozzleTip);

    // アフターバーナーエフェクト（コーンを先端に子として接続）
    const fireGeo = new THREE.ConeGeometry(0.3, 1.5, 16);
    fireGeo.rotateX(-Math.PI / 2); // 後ろへ噴射
    fireGeo.translate(0, 0, -0.75); // ノズルの少し後ろにずらす
    const fireMat = new THREE.MeshBasicMaterial({
      color: 0xffaa44,
      transparent: true,
      opacity: 0.8,
      blending: THREE.AdditiveBlending
    });
    this.afterburnerEffect = new THREE.Mesh(fireGeo, fireMat);
    this.nozzleTip.add(this.afterburnerEffect);
  }
}