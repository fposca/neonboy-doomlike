import { useEffect, useRef } from "react";

/* ===== Helpers ===== */
function loadImage(src) {
  return new Promise((res, rej) => {
    const img = new Image();
    img.onload = () => res(img);
    img.onerror = () => rej(new Error("No se pudo cargar: " + src));
    img.src = src; // desde /public
  });
}
const clampf = (v, a, b) => Math.max(a, Math.min(b, v));
const normAngle = (a)=>{ while(a<=-Math.PI)a+=2*Math.PI; while(a>Math.PI)a-=2*Math.PI; return a; };
const dist = (ax,ay,bx,by)=>Math.hypot(ax-bx, ay-by);

/* Línea de visión: true si no hay pared entre A y B */
function hasLineOfSight(ax, ay, bx, by, eps = 0.05, castFn) {
  const ang = Math.atan2(by - ay, bx - ax);
  const r = castFn(ax, ay, ang, 128);
  const d = Math.hypot(bx - ax, by - ay);
  return r.dist >= d - eps;
}

/* ===== Audio ===== */
function makeSfx(src, volume = 0.2) {
  const base = new Audio(src);
  base.preload = "auto";
  try { base.load(); } catch {}
  return () => {
    const a = base.cloneNode();
    a.volume = volume;
    try { a.currentTime = 0; } catch {}
    a.play().catch(()=>{});
  };
}

function makeMusic(src, volume = 0.35) {
  const a = new Audio(src);
  a.loop = true; a.volume = volume;

  let started = false;
  const unlock = () => { if (!started) { a.play().catch(()=>{}); started = true; } };

  const onClick  = () => unlock();
  const onKey    = () => unlock();
  window.addEventListener("click", onClick,  { once:true });
  window.addEventListener("keydown", onKey,  { once:true });

  return {
    play: () => a.play().catch(()=>{}),
    pause: () => a.pause(),
    setVolume: (v) => { a.volume = v; },
    dispose: () => {
      try { a.pause(); } catch {}
      a.src = "";
      window.removeEventListener("click", onClick);
      window.removeEventListener("keydown", onKey);
    }
  };
}

export default function Game() {
  const canvasRef = useRef(null);

  useEffect(() => {
    /* ---------- Canvas ---------- */
    const canvas = canvasRef.current;
    const W = 600, H = 320;
    canvas.width = W * 3; canvas.height = H * 3;
    const ctx = canvas.getContext("2d");
    ctx.imageSmoothingEnabled = false;
    canvas.tabIndex = 0; setTimeout(() => canvas.focus(), 0);

    const back = document.createElement("canvas");
    back.width = W; back.height = H;
    const bctx = back.getContext("2d");
    bctx.imageSmoothingEnabled = false;

    const CAM = { pitch: 0, PITCH_MAX: 0.38, yawSens: 0.0025, pitchSens: 0.0020 };

    /* ---------- Estados ---------- */
    // title | playing | levelcomplete | gameover | bossdead | theend
    let gameState = "title";
    let LEVEL = 1, MAX_LEVELS = 4;

    /* ---------- Juego / mapa ---------- */
    const MAX_ENEMIES = 60, SPAWN_EVERY = 1.3, INITIAL_ENEMIES = 6;

    let MAP_W = 32, MAP_H = 24;

    function makeMap(w,h, density=0.06){
      const A = new Array(w*h).fill(0);
      // bordes
      for (let x=0;x<w;x++){ A[x]=1; A[(h-1)*w+x]=1; }
      for (let y=0;y<h;y++){ A[y*w]=1; A[y*w+w-1]=1; }

      // densidad (nivel 4 usa 3 tipos de pared)
      const use3 = (LEVEL===4);
      const blocks = Math.floor(w*h*density);
      for (let i=0;i<blocks;i++){
        const x = 2 + Math.floor(Math.random()*(w-4));
        const y = 2 + Math.floor(Math.random()*(h-4));
        const t = use3 ? (1 + Math.floor(Math.random()*3)) : (Math.random()<0.5?1:2);
        if (Math.random()<0.5) for(let k=-1;k<=1;k++) A[y*w+(x+k)] = t;
        else                    for(let k=-1;k<=1;k++) A[(y+k)*w+x] = t;
      }
      return A;
    }

    let MAP = makeMap(MAP_W, MAP_H);
    const idx=(x,y)=>(y|0)*MAP_W+(x|0);
    const cell=(x,y)=>(x<0||y<0||x>=MAP_W||y>=MAP_H)?1:MAP[idx(x,y)];

    // Helpers de colisión con paredes (mobs/proyectiles)
    const isWall = (x, y) => cell(Math.floor(x), Math.floor(y)) !== 0;

    function canStand(x, y, r = 0.3) {
      if (isWall(x, y)) return false;
      if (isWall(x - r, y)) return false;
      if (isWall(x + r, y)) return false;
      if (isWall(x, y - r)) return false;
      if (isWall(x, y + r)) return false;
      const s = 0.7071 * r; // r/√2 para esquinas
      if (isWall(x - s, y - s)) return false;
      if (isWall(x + s, y - s)) return false;
      if (isWall(x - s, y + s)) return false;
      if (isWall(x + s, y + s)) return false;
      return true;
    }

    function slideMoveEntity(e, dx, dy) {
      const r = e.radius || 0.3;
      const nx = e.x + dx, ny = e.y + dy;
      if (canStand(nx, ny, r)) { e.x = nx; e.y = ny; return; }
      if (canStand(e.x, ny, r)) { e.y = ny; return; }
      if (canStand(nx, e.y, r)) { e.x = nx; return; }
      // bloqueado: no mover
    }

    /* Carvar zona segura cerca del spawn del jugador para evitar encierros */
    function carveSafeZone(cx, cy, rad=2.0){
      const x0 = Math.max(1, Math.floor(cx - rad));
      const y0 = Math.max(1, Math.floor(cy - rad));
      const x1 = Math.min(MAP_W-2, Math.ceil(cx + rad));
      const y1 = Math.min(MAP_H-2, Math.ceil(cy + rad));
      for (let y=y0; y<=y1; y++){
        for (let x=x0; x<=x1; x++){
          MAP[idx(x,y)] = 0; // limpiar
        }
      }
      // abrir corredor hacia el centro
      for (let y=y1; y>=Math.floor(MAP_H/2); y--){
        MAP[idx(Math.max(2,Math.floor(cx)), y)] = 0;
      }
    }
/* Carvar arena para el boss + corredor al centro del mapa */
function carveBossZone(cx, cy, rad = 2.5) {
  // limpiar un cuadrado alrededor del boss
  const x0 = Math.max(1, Math.floor(cx - rad));
  const y0 = Math.max(1, Math.floor(cy - rad));
  const x1 = Math.min(MAP_W - 2, Math.ceil(cx + rad));
  const y1 = Math.min(MAP_H - 2, Math.ceil(cy + rad));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      MAP[idx(x, y)] = 0;
    }
  }

  // abrir un corredor hacia el centro del mapa
  const cxI = Math.floor(cx), cyI = Math.floor(cy);
  const midX = Math.floor(MAP_W / 2), midY = Math.floor(MAP_H / 2);

  // primero horizontal, luego vertical (tipo “┘”)
  const width = 1; // grosor del corredor (podés subir a 2 si querés más ancho)
  for (let x = Math.min(cxI, midX); x <= Math.max(cxI, midX); x++) {
    for (let k = -width; k <= width; k++) MAP[idx(x, clampf(cyI + k, 1, MAP_H - 2))] = 0;
  }
  for (let y = Math.min(cyI, midY); y <= Math.max(cyI, midY); y++) {
    for (let k = -width; k <= width; k++) MAP[idx(clampf(midX + k, 1, MAP_W - 2), y)] = 0;
  }
}

    const player = {
      x: 3.5, y: MAP_H-2.5, a: -Math.PI/2, fov: Math.PI/3,
      speed: 2.0, rotSpeed: 2.2,
      hp: 100,
      weapon: "pistol",   // fists | pistol | shotgun
      ammo: 24,           // balas de pistola
      shells: 0,          // cartuchos escopeta
      fireCooldown: 0, fireRate: 0.22,
    };

    // victoria niveles 1-3
    const WIN_DEMONS = 1, WIN_ORCS = 0, WIN_GREENS = 10;
    let killsDemons = 0, killsOrcs = 0, greens = 0;
    let gameOver = false, win = false;

    /* ---------- Enemigos ---------- */
    const enemies = [];
    const ENEMY_SPEED = 0.85;                   // base demon/orc
    const BOLA_SPEED  = ENEMY_SPEED * 2.0;      // bola = doble
    const TOUCH_DMG_NORMAL = 10;
    const TOUCH_DMG_BOLA   = TOUCH_DMG_NORMAL * 2; // bola = doble
    const CONTACT_DPS = 25;
    const BACKOFF_DIST = 0.6, BACKOFF_TIME = 0.5, TOUCH_COOLDOWN = 0.6;

    // ===== Boss y proyectiles (Nivel 4) =====
    const projectiles = [];
    const FIREBALL_SPEED = 3.0;
    const FIREBALL_DMG = 10;
    const BOSS_HP = 2500;
    const BOSS_TOUCH_DMG = 25;

    function makeEnemy(x, y, type) {
      if (!type) {
        const r = Math.random();
        type = r < 0.6 ? "demon" : r < 0.9 ? "orc" : "bola";
      }
      const baseHp =
        type === "orc"  ? 80 :
        type === "demon"? 40 :
                          300; // bola
      return {
        x, y, hp: baseHp, alive: true,
        radius: type==="bola" ? 0.28 : 0.3,
        dir: Math.random()*Math.PI*2,
        state: "walk",       // walk | hit | dead
        hitT: 0, backOffT: 0, touchCd: 0,
        stepT: 0, dieFrame: 0,
        lastX: x, lastY: y,  // para detectar dirección de movimiento
        type,
      };
    }

    function makeBoss(x,y){
      return {
        x, y, hp: BOSS_HP, alive: true, type: "boss",
        radius: 0.6, dir: 0, state: "walk",
        hitT: 0, backOffT: 0, touchCd: 0, stepT: 0, dieFrame: 0,
        shootCd: 0, deathTimer: 0,
        lastX: x, lastY: y,
      };
    }

    /* ---------- Pickups ---------- */
    const pickups=[];
    function randomSpawnPos(min=6){
      for(let t=0;t<120;t++){
        const x=1.5+Math.random()*(MAP_W-3), y=1.5+Math.random()*(MAP_H-3);
        if (dist(player.x,player.y,x,y)>min && canStand(x,y,0.3)) return {x,y};
      }
      return null;
    }
    function addRandomPickups(count,type){
      for(let i=0;i<count;i++){
        const p=randomSpawnPos(3+Math.random()*6); if(!p)continue;
        if(type==="ammo")   pickups.push({x:p.x,y:p.y,type,amount:12,taken:false});
        if(type==="shells") pickups.push({x:p.x,y:p.y,type,amount:6,taken:false});
        if(type==="health") pickups.push({x:p.x,y:p.y,type,taken:false});
        if(type==="green")  pickups.push({x:p.x,y:p.y,type,taken:false});
      }
    }

    /* ---------- Audio ---------- */
    const SFX = {
      shoot:        makeSfx("/sfx/shoot.wav", 0.8),
      shotgun:      makeSfx("/sfx/shotgun.mp3", 0.9),
      punch:        makeSfx("/sfx/punch.wav", 0.8),
      enemyDie:     makeSfx("/sfx/enemy_die.wav", 0.9),
      enemySpawn:   makeSfx("/sfx/enemy_spawn.wav", 0.6),
      breath1:      makeSfx("/sfx/enemy_breath_1.wav", 0.6),
      breath2:      makeSfx("/sfx/enemy_breath_2.wav", 0.6),
      pickupAmmo:   makeSfx("/sfx/pickup_ammo.wav", 0.7),
      pickupShells: makeSfx("/sfx/pickup_shells.mp3", 0.7),
      pickupHealth: makeSfx("/sfx/pickup_health.wav", 0.7),
      pickupGreen:  makeSfx("/sfx/pickup_green.wav", 0.7),
      hurt:         makeSfx("/sfx/hurt.wav", 0.7),
      bolaSpawn:    makeSfx("/sfx/bola_spawn.wav", 0.8),
      bossHit:      makeSfx("/sfx/boss_hit.wav", 0.9),
      bossDie:      makeSfx("/sfx/boss_die.wav", 1.0),
      fireball:     makeSfx("/sfx/fireball.wav", 0.6),
    };
    const MUSIC = makeMusic("/music/loop.ogg", 0.11);

    /* ---------- Respiración aleatoria ---------- */
    let breathLoopStarted = false;
    let nextBreath1 = Infinity, nextBreath2 = Infinity;
    const BREATH1_MIN = 14_000, BREATH1_MAX = 18_000;
    const BREATH2_MIN = 24_000, BREATH2_MAX = 30_000;
    const SEP_GUARD   = 2_000;
    const randMs = (min,max)=>min+Math.random()*(max-min);

    function startBreathLoop(nowMs){
      if (breathLoopStarted) return;
      breathLoopStarted = true;
      (Math.random()<0.5 ? SFX.breath1 : SFX.breath2)();
      nextBreath1 = nowMs + randMs(BREATH1_MIN, BREATH1_MAX);
      nextBreath2 = nowMs + randMs(BREATH2_MIN, BREATH2_MAX);
      if (Math.abs(nextBreath1-nextBreath2) < SEP_GUARD) nextBreath2 += SEP_GUARD;
    }
    function updateBreath(nowMs){
      if (!breathLoopStarted) return;
      if (!enemies.some(e=>e.alive)) return;
      if (nowMs >= nextBreath1){ SFX.breath1(); nextBreath1 = nowMs + randMs(BREATH1_MIN, BREATH1_MAX); if (Math.abs(nextBreath1-nextBreath2)<SEP_GUARD) nextBreath1+=SEP_GUARD; }
      if (nowMs >= nextBreath2){ SFX.breath2(); nextBreath2 = nowMs + randMs(BREATH2_MIN, BREATH2_MAX); if (Math.abs(nextBreath2-nextBreath1)<SEP_GUARD) nextBreath2+=SEP_GUARD; }
    }

    /* ---------- Input ---------- */
    const keys={};
    const handledKeys = new Set(["KeyW","KeyA","KeyS","KeyD","KeyQ","KeyE","Digit1","Digit2","Digit3","Enter","F5"]);

    // placeholders (serán reescritas tras cargar assets)
    let startGame = ()=>{};
    let resetGame = ()=>{};
    let endGame   = ()=>{};
    let nextLevel = ()=>{};
    const _helpers = {};

    const onKey = (e,down)=>{
      if (handledKeys.has(e.code)) e.preventDefault();

      // F5: recarga total del juego
      if (down && e.code==="F5") {
        window.location.reload();
        return;
      }

      if (down && e.code==="Enter") {
        if (gameState==="title") { startGame(); return; }
        if (gameState==="levelcomplete") { nextLevel(); return; }
        if (gameState==="gameover") { resetGame(); return; }
        if (gameState==="theend") {
          LEVEL = 1;
          resetGame();
          return;
        }
      }

      if (down && gameState==="playing") {
        if (e.code==="Digit1") player.weapon="fists";
        if (e.code==="Digit2") { if (player.ammo>0)   player.weapon="pistol"; }
        if (e.code==="Digit3") { if (player.shells>0) player.weapon="shotgun"; }
        if (e.code==="KeyZ"){
          if (LEVEL===4) return; // sin spawns manuales en nivel 4 (jefe)
          const p=randomSpawnPos(5);
          if(p && enemies.length<MAX_ENEMIES){
            const wasEmpty = enemies.length===0;
            const ne = makeEnemy(p.x,p.y);
            enemies.push(ne);
            if (ne.type === "bola") SFX.bolaSpawn(); else SFX.enemySpawn();
            if (wasEmpty) startBreathLoop(performance.now());
          }
        }
      }
      keys[e.code]=down;
    };
    const onDown=e=>onKey(e,true), onUp=e=>onKey(e,false);
    window.addEventListener("keydown", onDown);
    window.addEventListener("keyup", onUp);

    const togglePointerLock = ()=>{ if(gameState==="playing" && !gameOver){ canvas.focus(); canvas.requestPointerLock(); } };
    canvas.addEventListener("click", togglePointerLock);
    const onMouseMove = (e)=>{
      if (gameState!=="playing" || gameOver) return;
      if (document.pointerLockElement===canvas){
        player.a += e.movementX * CAM.yawSens;
        CAM.pitch = clampf(CAM.pitch - e.movementY*CAM.pitchSens, -CAM.PITCH_MAX, CAM.PITCH_MAX);
      }
    };
    window.addEventListener("mousemove", onMouseMove);
    let mouseDown=false;
    const onMouseDown = ()=>{ if(gameState==="playing" && !gameOver) mouseDown=true; };
    const onMouseUp   = ()=>{ mouseDown=false; };
    window.addEventListener("mousedown", onMouseDown);
    window.addEventListener("mouseup", onMouseUp);

    /* ---------- Raycasting ---------- */
    function castRayDDA(px,py,ang,maxSteps=64){
      const dirX=Math.cos(ang), dirY=Math.sin(ang);
      let mapX=Math.floor(px), mapY=Math.floor(py);
      const dX=Math.abs(1/(dirX||1e-6)), dY=Math.abs(1/(dirY||1e-6));
      let stepX,sdX; if(dirX<0){stepX=-1;sdX=(px-mapX)*dX;} else {stepX=1;sdX=(mapX+1-px)*dX;}
      let stepY,sdY; if(dirY<0){stepY=-1;sdY=(py-mapY)*dY;} else {stepY=1;sdY=(mapY+1-py)*dY;}
      let side=0,tile=0,steps=0;
      while(steps++<maxSteps){
        if(sdX<sdY){ sdX+=dX; mapX+=stepX; side=0; } else { sdY+=dY; mapY+=stepY; side=1; }
        tile=cell(mapX,mapY); if(tile>0) break;
      }
      let perp = (side===0)?(mapX-px+(1-stepX)/2)/(dirX||1e-6):(mapY-py+(1-stepY)/2)/(dirY||1e-6);
      const hitX=px+dirX*perp, hitY=py+dirY*perp;
      let u=(side===0)?(hitY-Math.floor(hitY)):(hitX-Math.floor(hitX));
      if((side===0&&dirX>0)||(side===1&&dirY<0)) u=1-u;
      return { dist:Math.max(0.0001,perp), side, tile, u };
    }

    /* ---------- Sprites / Armas / HUD ---------- */
    const TEX = { 1:null, 2:null, 3:null };
    const WEAPON = {
      fists:   { idle:null, fire:null, damage:15, uses:null       },
      pistol:  { idle:null, fire:null, damage:25, uses:"ammo"     },
      shotgun: { idle:null, fire:null, damage:50, uses:"shells"   },
    };

    const SPR = {
      demon: { frontL:null, frontR:null, back:null, left:null, right:null, hit1:null, hit2:null, die1:null, die2:null },
      orc:   { front:null, frontWalk:null, back:null, left:null, right:null, die1:null, die2:null },
      bola:  { front:null, left:null, right:null, back:null, dead:null },
      boss:  { f1:null, f2:null, back:null, left:null, right:null, hit:null, die1:null, die2:null },
    };

    const PICKIMG = { ammo:null, health:null, green:null, shells:null };
    const HUD = { panel:null, face:{ idle:null, fire:null, hurt:null }, cover:null, final:null };

    // Cara estilo Doom
    const face = { state:"idle", timer:0, FIRE_TIME:0.25, HURT_TIME:0.6 };
    const setFaceState = (s,t=0)=>{ face.state=s; face.timer=t; };

    // ---- Flash rojo al recibir daño ----
    let hitFlash = 0;
    const HIT_FLASH_TIME = 0.25;

    // ---- Cooldown del sonido de daño ----
    let hurtSfxCooldown = 0;

    // ---- Invulnerabilidad global para evitar “metralleta” de daño ----
    let invulnT = 0;
    const GLOBAL_INVULN = 0.28; // 280 ms

    // Helper: aplicar daño (evita spam de SFX)
    function applyPlayerDamage(amount, flashK = 1.0) {
      if (gameState !== "playing") return;
      if (amount <= 0) return;

      // Si estamos invulnerables, ignorar daño y NO sonar
      if (invulnT > 0) return;

      const prev = player.hp|0;
      player.hp = Math.max(0, player.hp - amount);
      const nowHp = player.hp|0;

      // Solo si realmente bajó la vida
      if (nowHp < prev) {
        invulnT = GLOBAL_INVULN;        // activar ventana de invulnerabilidad
        setFaceState("hurt", face.HURT_TIME);
        hitFlash = HIT_FLASH_TIME * flashK;

        if (hurtSfxCooldown === 0) {
          SFX.hurt();
          hurtSfxCooldown = 0.15;       // 150 ms anti-spam del sonido
        }
      }

      if (player.hp <= 0) {
        player.hp = 0;
        endGame(false);
      }
    }

    // Texturas por nivel
    const TEXSETS = {
      1: { t1: "brick_red",   t2: "brick_pink"     },
      2: { t1: "mosaico3",    t2: "mosaico4"       }, // /sprites/mosaico-3.jpg y /sprites/mosaico-44.jpg
      3: { t1: "mosaico4jpg", t2: "mosaico5jpg"    }, // /sprites/mosaico-4.jpg y /sprites/mosaico-5.jpg
      4: { t1: "mosaico11",   t2: "mosaico12", t3:"mosaico13" },
    };
    function applyTexturesForLevel(images) {
      const set = TEXSETS[LEVEL] || TEXSETS[1];
      TEX[1] = images[set.t1] || null;
      TEX[2] = images[set.t2] || null;
      TEX[3] = images[set.t3] || null; // null en niveles 1-3
    }

    // Piso y techo (pattern cacheados)
    let FLOOR_IMG = null, CEIL_IMG = null;
    let FLOOR_PATTERN = null, CEIL_PATTERN = null;

    // Control de RAF/cleanup
    let rafId = 0;
    let cleanup = null;

    Promise.all([
      // DEMON
      loadImage("/sprites/frente-izquierda.png"),
      loadImage("/sprites/frente-derecha.png"),
      loadImage("/sprites/back.png"),
      loadImage("/sprites/izquierda.png"),
      loadImage("/sprites/derecha.png"),
      loadImage("/sprites/hit-1.png"),
      loadImage("/sprites/hit-2.png"),
      loadImage("/sprites/die-1.png"),
      loadImage("/sprites/die-2.png"),
      // ORC
      loadImage("/sprites/orco-frente.png"),
      loadImage("/sprites/adelante-1.png"),
      loadImage("/sprites/orco-espalda.png"),
      loadImage("/sprites/orco-izquierda.png"),
      loadImage("/sprites/orco-derecha.png"),
      loadImage("/sprites/orco-muerto.png"),
      loadImage("/sprites/orco-muerto-1.png"),
      // BOLA
      loadImage("/sprites/bola-frente.png").catch(()=>null),
      loadImage("/sprites/bola-izquierda.png").catch(()=>null),
      loadImage("/sprites/bola-derecha.png").catch(()=>null),
      loadImage("/sprites/bola-atras.png").catch(()=>null),
      loadImage("/sprites/bola-muerta.png").catch(()=>null),
      // armas
      loadImage("/sprites/fists.png").catch(()=>null),
      loadImage("/sprites/fists-2.png").catch(()=>null),
      loadImage("/sprites/gun.png").catch(()=>null),
      loadImage("/sprites/gun-2.png").catch(()=>loadImage("/sprites/gin-2.png").catch(()=>null)),
      loadImage("/sprites/escopeta.png").catch(()=>null),
      loadImage("/sprites/escopeta-2.png").catch(()=>null),
      // pickups + walls (niveles 1 y 2)
      loadImage("/sprites/ammo.png").catch(()=>null),
      loadImage("/sprites/heart.png").catch(()=>null),
      loadImage("/sprites/pedal.png").catch(()=>null),
      loadImage("/sprites/shells.png").catch(()=>null),
      loadImage("/sprites/brick_red.png").catch(()=>null),
      loadImage("/sprites/brick_pink.jpg").catch(()=>null),
      loadImage("/sprites/mosaico-3.jpg").catch(()=>null),   // -> mosaico3
      loadImage("/sprites/mosaico-44.jpg").catch(()=>null),  // -> mosaico4
      // nivel 3
      loadImage("/sprites/mosaico-4.jpg").catch(()=>null),   // -> mosaico4jpg
      loadImage("/sprites/mosaico-5.jpg").catch(()=>null),   // -> mosaico5jpg
      // nivel 4
      loadImage("/sprites/mosaico-11.png").catch(()=>null),
      loadImage("/sprites/mosaico-12.png").catch(()=>null),
      loadImage("/sprites/mosaico-13.png").catch(()=>null),
      // PISO y TECHO
      loadImage("/sprites/piso.jpg").catch(()=>null),
      loadImage("/sprites/techo.jpg").catch(()=>null),
      // HUD + portada + final
      loadImage("/sprites/hud/panel.png").catch(()=>null),
      loadImage("/sprites/hud/face-normal.png").catch(()=>null),
      loadImage("/sprites/hud/face-sadic.png").catch(()=>null),
      loadImage("/sprites/hud/face-pain.png").catch(()=>null),
      loadImage("/sprites/freepik__agregar-ondo__55653.png").catch(()=>null),
      loadImage("/sprites/final.jpg").catch(()=>null),

      // JEFE
      loadImage("/sprites/monster-frente-1.png").catch(()=>null),
      loadImage("/sprites/monster-frente-2.png").catch(()=>null),
      loadImage("/sprites/monster-back.png").catch(()=>null),
      loadImage("/sprites/monster-izquierda.png").catch(()=>null),
      loadImage("/sprites/monster-derecha.png").catch(()=>null),
      loadImage("/sprites/monster-hit.png").catch(()=>null),
      loadImage("/sprites/monster-die-1.png").catch(()=>null),
      loadImage("/sprites/monster-die-2.png").catch(()=>null),
    ]).then(([
      // demon
      d_frI, d_frD, d_back, d_left, d_right, d_hit1, d_hit2, d_die1, d_die2,
      // orc
      o_front, o_frontWalk, o_back, o_left, o_right, o_die1, o_die2,
      // bola
      b_front, b_left, b_right, b_back, b_dead,
      // armas
      fistsIdle, fistsFire, gunIdle, gunFire, shIdle, shFire,
      // pickups + walls + mosaicos (niv1/2)
      pngAmmo, pngHeart, pngGreen, pngShells, brickRed, brickPink, mosaico3, mosaico4,
      // nivel 3 jpg
      mosaico4jpg, mosaico5jpg,
      // paredes nivel 4
      tex11, tex12, tex13,
      // piso/techo
      pisoImg, techoImg,
      // HUD
      hudPanel, faceIdle, faceFire, faceHurt, coverImg,
      finalImg,
      // boss
      boss_f1, boss_f2, boss_back, boss_left, boss_right, boss_hit, boss_die1, boss_die2
    ])=>{
      // demon
      SPR.demon.frontL=d_frI; SPR.demon.frontR=d_frD; SPR.demon.back=d_back; SPR.demon.left=d_left; SPR.demon.right=d_right;
      SPR.demon.hit1=d_hit1; SPR.demon.hit2=d_hit2; SPR.demon.die1=d_die1; SPR.demon.die2=d_die2;
      // orc
      SPR.orc.front=o_front; SPR.orc.frontWalk=o_frontWalk; SPR.orc.back=o_back; SPR.orc.left=o_left; SPR.orc.right=o_right; SPR.orc.die1=o_die1; SPR.orc.die2=o_die2;
      // bola
      SPR.bola.front=b_front||null; SPR.bola.left=b_left||null; SPR.bola.right=b_right||null; SPR.bola.back=b_back||null; SPR.bola.dead=b_dead||null;
      // boss
      SPR.boss.f1=boss_f1||null; SPR.boss.f2=boss_f2||boss_f1||null; SPR.boss.back=boss_back||null;
      SPR.boss.left=boss_left||null; SPR.boss.right=boss_right||null; SPR.boss.hit=boss_hit||SPR.boss.f2;
      SPR.boss.die1=boss_die1||SPR.boss.f1; SPR.boss.die2=boss_die2||SPR.boss.f2;

      // armas
      WEAPON.fists.idle=fistsIdle||null;   WEAPON.fists.fire=fistsFire||fistsIdle||null;
      WEAPON.pistol.idle=gunIdle||null;    WEAPON.pistol.fire=gunFire||gunIdle||null;
      WEAPON.shotgun.idle=shIdle||null;    WEAPON.shotgun.fire=shFire||shIdle||null;

      // pickups
      PICKIMG.ammo=pngAmmo||null; PICKIMG.health=pngHeart||null; PICKIMG.green=pngGreen||null; PICKIMG.shells=pngShells||null;

      // texturas
      const allTex = {
        brick_red: brickRed || null,
        brick_pink: brickPink || null,
        mosaico3: mosaico3 || null,
        mosaico4: mosaico4 || null,
        mosaico4jpg: mosaico4jpg || null,
        mosaico5jpg: mosaico5jpg || null,
        mosaico11: tex11 || null,
        mosaico12: tex12 || null,
        mosaico13: tex13 || null,
      };
      applyTexturesForLevel(allTex);

      // Piso/Techo + patterns
      FLOOR_IMG = pisoImg || null;
      CEIL_IMG  = techoImg || null;
      FLOOR_PATTERN = FLOOR_IMG ? bctx.createPattern(FLOOR_IMG, "repeat") : null;
      CEIL_PATTERN  = CEIL_IMG  ? bctx.createPattern(CEIL_IMG,  "repeat") : null;

      // hud
      HUD.panel=hudPanel||null;
      HUD.face.idle=faceIdle||null; HUD.face.fire=faceFire||faceIdle||null; HUD.face.hurt=faceHurt||faceIdle||null;
      HUD.cover=coverImg||null;
      HUD.final=finalImg||null;

      // arrancamos en pantalla de título
      drawTitle();
      rafId = requestAnimationFrame(tick);

      /* ---------- Helpers de nivel ---------- */
      nextLevel = function() {
        LEVEL = LEVEL < MAX_LEVELS ? LEVEL + 1 : 1; // si pasa el 4 vuelve al 1
        const dens = LEVEL===1 ? 0.06 : LEVEL===2 ? 0.08 : LEVEL===3 ? 0.10 : 0.12;
        MAP = makeMap(MAP_W, MAP_H, dens);
        // tallar zona segura
        carveSafeZone(3.5, MAP_H-2.5, 2.2);
        applyTexturesForLevel(allTex);
        resetGameCore();
        gameState = "playing";
      };

      function resetGameCore() {
        Object.assign(player, { x:3.5, y:MAP_H-2.5, a:-Math.PI/2, hp:100, ammo:24, shells:0, weapon:"pistol", fireCooldown:0 });
        CAM.pitch=0; killsDemons=0; killsOrcs=0; greens=0; gameOver=false; win=false; face.state="idle"; face.timer=0;
        hitFlash = 0;

        enemies.length=0;
        projectiles.length=0;

        if (LEVEL === 4) {
  // jefe
  let p = randomSpawnPos(8);
  if (!p) p = { x: MAP_W - 4.5, y: 4.5 };

  // >>> AÑADIR ESTAS LÍNEAS ANTES DE ENCOLAR AL JEFE <<<
  carveBossZone(p.x, p.y, 2.5);     // abre arena + corredor al centro
  carveSafeZone(3.5, MAP_H - 2.5, 2.2); // (ya la tenías, asegura la salida del jugador)

  enemies.push(makeBoss(p.x, p.y));
} else {
          for (let i=0;i<INITIAL_ENEMIES;i++){
            const p = randomSpawnPos(5) || { x:6.5, y:MAP_H-6.5 };
            enemies.push(makeEnemy(p.x,p.y));
          }
        }
        breathLoopStarted=false; startBreathLoop(performance.now());
        pickups.length=0;
        addRandomPickups(8,"ammo"); addRandomPickups(5,"shells");
        addRandomPickups(8,"health"); addRandomPickups(8,"green");
        for (const k of Object.keys(keys)) delete keys[k];
        mouseDown = false;
      }

      // sobreescribimos funciones que dependen de assets:
      startGame = function(){
        LEVEL = 1;
        applyTexturesForLevel(allTex);
        MAP = makeMap(MAP_W, MAP_H, 0.06);
        carveSafeZone(3.5, MAP_H-2.5, 2.2);
        MUSIC.play();
        resetGameCore();
        canvas.focus();
        gameState = "playing";
      };

      resetGame = function(){
        applyTexturesForLevel(allTex);
        const dens = LEVEL===1 ? 0.06 : LEVEL===2 ? 0.08 : LEVEL===3 ? 0.10 : 0.12;
        MAP = makeMap(MAP_W, MAP_H, dens);
        carveSafeZone(3.5, MAP_H-2.5, 2.2);
        resetGameCore();
        gameState = "playing";
      };

      endGame = function(v){
        gameOver = true; win=v;
        gameState = v ? "levelcomplete" : "gameover";
      };

      _helpers.nextLevel = nextLevel;

      /* ---------- Anim arma ---------- */
      let weaponAnim = { state:"idle", t:0, duration:0, recoil:0 };

      /* ---------- Loop ---------- */
      let last = performance.now();
      const depthBuf = new Float32Array(W);
      let spawnTimer = 0;
      let bossDeathTimer = 0; // 4s para ver anim

      function tryMove(nx,ny){
        if(cell(nx,ny)===0){ player.x=nx; player.y=ny; return; }
        if(cell(nx,player.y)===0) player.x=nx;
        if(cell(player.x,ny)===0) player.y=ny;
      }

      // separación suave para evitar apilado
      function separateEnemies(){
        const R = 0.32;
        for (let i=0;i<enemies.length;i++){
          const a = enemies[i]; if(!a.alive) continue;
          for (let j=i+1;j<enemies.length;j++){
            const b = enemies[j]; if(!b.alive) continue;
            const dx = b.x - a.x, dy = b.y - a.y;
            const d2 = dx*dx + dy*dy, min = (R+R);
            if (d2 < min*min && d2 > 0.0001){
              const d = Math.sqrt(d2);
              const push = (min - d) * 0.5;
              const nx = dx / d, ny = dy / d;
              slideMoveEntity(a, -nx*push, -ny*push);
              slideMoveEntity(b,  nx*push,  ny*push);
            }
          }
        }
      }

     function enemyOnCrosshair(e, horizonShift) {
  const angToE = Math.atan2(e.y - player.y, e.x - player.x);
  const diffA  = Math.abs(normAngle(angToE - player.a));
  if (diffA > 0.06) return false;

  const r = castRayDDA(player.x, player.y, player.a);
  const dWall = r.dist;

  const dE = dist(player.x, player.y, e.x, e.y);
  if (dE > dWall + 0.05) return false;

  const distFix = dE * Math.cos(diffA);
  const size = Math.max(8, (H / distFix) | 0);

  const sy = ((H/2 + horizonShift) - size/2) | 0;
  const cy = (H/2 + horizonShift) | 0;

  return (cy >= sy && cy <= sy + size);
}


      function damageEnemy(e,dmg){
        if(!e.alive) return;
        e.hp -= dmg;

        if (e.type === "boss") {
          SFX.bossHit && SFX.bossHit();
        }

        if(e.hp<=0){
          e.alive=false; e.state="dead"; e.dieFrame=0;
          if (e.type === "orc") killsOrcs++;
          else if (e.type==="demon") killsDemons++;

          if (e.type === "boss") {
            SFX.bossDie && SFX.bossDie();
            bossDeathTimer = 4.0;
            gameState = "bossdead";
          } else {
            SFX.enemyDie();
            if(!gameOver && ((killsDemons>=WIN_DEMONS && killsOrcs>=WIN_ORCS) || greens>=WIN_GREENS)) endGame(true);
          }
        } else {
          e.state="hit"; e.hitT=0.18;
        }
      }

      // ===== Tamaño del boss =====
      const BOSS_SCALE = 1.6; // Ajustá el tamaño del boss acá

      function tick(now){
        const dt = Math.min(0.05, (now-last)/1000); last=now;

        // enfriar cooldowns
        hurtSfxCooldown = Math.max(0, hurtSfxCooldown - dt);
        invulnT = Math.max(0, invulnT - dt);

        if (gameState === "title") {
          drawTitle();
          rafId = requestAnimationFrame(tick);
          return;
        }

        // Estado: boss muerto (4s de anim), luego THE END
        if (gameState === "bossdead") {
          bossDeathTimer = Math.max(0, bossDeathTimer - dt);
          for (const e of enemies) {
            if (e.type==="boss") e.dieFrame = Math.min(1, e.dieFrame + dt*0.5);
          }
          const hShift = (CAM.pitch * H * 0.45) | 0;
          drawFrame(hShift, now);
          if (bossDeathTimer === 0) gameState = "theend";
          rafId = requestAnimationFrame(tick);
          return;
        }

        if (gameState === "theend") {
          drawFinalScreen();
          rafId = requestAnimationFrame(tick);
          return;
        }

        if(!gameOver || gameState==="levelcomplete"){
          if (gameState==="playing"){
            const forward=(keys.KeyW?1:0)-(keys.KeyS?1:0);
            const strafe =(keys.KeyD?1:0)-(keys.KeyA?1:0);
            const rot    =(keys.KeyE?1:0)-(keys.KeyQ?1:0);
            player.a += rot*player.rotSpeed*dt;
            const cs=Math.cos(player.a), sn=Math.sin(player.a);
            tryMove(player.x + (cs*forward - sn*strafe)*player.speed*dt,
                    player.y + (sn*forward + cs*strafe)*player.speed*dt);

            // spawns automáticos (NO en nivel 4)
            spawnTimer += dt;
            if (LEVEL !== 4 && spawnTimer >= SPAWN_EVERY && enemies.length < MAX_ENEMIES) {
              const p = randomSpawnPos(7);
              if (p) {
                const wasEmpty=enemies.length===0;
                const ne = makeEnemy(p.x,p.y);
                enemies.push(ne);
                if (ne.type === "bola") SFX.bolaSpawn(); else SFX.enemySpawn();
                if (wasEmpty) startBreathLoop(performance.now());
              }
              spawnTimer = 0;
            }

            // pickups
            for (const p of pickups){
              if(p.taken) continue;
              if(dist(player.x,player.y,p.x,p.y)<0.6){
                if(p.type==="ammo"){
                  const hadFists = player.weapon==="fists" && player.ammo===0;
                  player.ammo += p.amount; SFX.pickupAmmo();
                  if (hadFists && player.ammo>0) player.weapon="pistol";
                }
                if(p.type==="shells"){
                  const hadNoShot = (player.weapon!=="shotgun" && player.shells===0);
                  player.shells += p.amount; SFX.pickupShells();
                  if (hadNoShot && player.shells>0) player.weapon="shotgun";
                }
                if(p.type==="health"){ player.hp=Math.min(100, player.hp+10); SFX.pickupHealth(); }
                if(p.type==="green"){ greens++; SFX.pickupGreen(); if(!gameOver && ((killsDemons>=WIN_DEMONS && killsOrcs>=WIN_ORCS) || greens>=WIN_GREENS)) endGame(true); }
                p.taken=true;
              }
            }

            // enemigos
            for(const e of enemies){
              // guardar pos previa para detectar dirección real de movimiento
              e.prevX = e.x; e.prevY = e.y;

              if(e.state==="hit"){ e.hitT-=dt; if(e.hitT<=0) e.state="walk"; }
              if(!e.alive){ e.state="dead"; e.dieFrame = Math.min(1, e.dieFrame + dt*0.8); continue; }

              e.stepT += dt*6;
              if(e.backOffT>0) e.backOffT-=dt;
              if(e.touchCd>0)  e.touchCd -=dt;

              let ang = Math.atan2(player.y - e.y, player.x - e.x);
              if(e.backOffT>0) ang += Math.PI;
              e.dir = ang;

              const speed = (e.type==="bola") ? BOLA_SPEED : ENEMY_SPEED;
              const dx = Math.cos(ang) * speed * dt;
              const dy = Math.sin(ang) * speed * dt;
              slideMoveEntity(e, dx, dy);

              // actualizar delta real de movimiento
              const mvx = e.x - e.prevX;
              const mvy = e.y - e.prevY;
              e.moveSpeed = Math.hypot(mvx, mvy);
              e.moveAng = e.moveSpeed>0.0001 ? Math.atan2(mvy, mvx) : e.moveAng || 0;

              // Daño por toque (cooldown) + LOS
              const d = dist(player.x, player.y, e.x, e.y);
              if (d < 0.6 && e.touchCd <= 0 && hasLineOfSight(e.x, e.y, player.x, player.y, 0.05, castRayDDA)) {
                const touch = (e.type==="bola") ? TOUCH_DMG_BOLA : (e.type==="boss" ? BOSS_TOUCH_DMG : TOUCH_DMG_NORMAL);
                applyPlayerDamage(touch, 1.0);

                e.touchCd = TOUCH_COOLDOWN;
                e.backOffT = BACKOFF_TIME;
                const away = Math.atan2(e.y - player.y, e.x - player.x);
                const bx = Math.cos(away) * BACKOFF_DIST;
                const by = Math.sin(away) * BACKOFF_DIST;
                slideMoveEntity(e, bx, by);
              }

              // Boss: disparo fireball con LOS (con offset para no nacer encima)
              if (e.type === "boss") {
                e.shootCd = Math.max(0, e.shootCd - dt);
                const toPlayer = Math.atan2(player.y - e.y, player.x - e.x);
                e.dir = toPlayer;
                if (e.shootCd === 0 && hasLineOfSight(e.x, e.y, player.x, player.y, 0.08, castRayDDA)) {
                  const muzzle = 0.7; // offset desde el centro del boss
                  const sx = e.x + Math.cos(toPlayer) * muzzle;
                  const sy = e.y + Math.sin(toPlayer) * muzzle;
                  const vx = Math.cos(toPlayer) * FIREBALL_SPEED;
                  const vy = Math.sin(toPlayer) * FIREBALL_SPEED;
                  projectiles.push({ x:sx, y:sy, vx, vy, alive:true, dmg:FIREBALL_DMG });
                  SFX.fireball && SFX.fireball();
                  e.shootCd = 1.1;
                }
              }
            }

            // anti-apilado
            separateEnemies();

            // Projectiles
            for (const p of projectiles) {
              if (!p.alive) continue;
              const nx = p.x + p.vx * dt;
              const ny = p.y + p.vy * dt;
              if (isWall(nx, ny)) { p.alive = false; continue; }
              p.x = nx; p.y = ny;
              if (dist(player.x, player.y, p.x, p.y) < 0.35) {
                applyPlayerDamage(p.dmg, 0.9);
                p.alive = false;
              }
            }

            // disparo / puños
            player.fireCooldown = Math.max(0, player.fireCooldown - dt);
            const wantShoot = mouseDown;

            const active = player.weapon;
            const wp = WEAPON[active];
            const hasAmmo =
              wp.uses === null ? true :
              wp.uses === "ammo"   ? player.ammo   > 0 :
              wp.uses === "shells" ? player.shells > 0 : false;

            if (wantShoot && player.fireCooldown <= 0) {
              if (active === "fists" || hasAmmo) {
                if (active === "pistol") SFX.shoot();
                else if (active === "shotgun") SFX.shotgun();
                else SFX.punch();
                setFaceState("fire", face.FIRE_TIME);

                let hitIdx=-1, best=1e9; const hs=((CAM.pitch*H*0.45)|0);
                for(let i=0;i<enemies.length;i++){
                  const e=enemies[i]; if(!e.alive) continue;
                  if(!enemyOnCrosshair(e,hs)) continue;
                  const d=dist(player.x,player.y,e.x,e.y);
                  if(d<best){ best=d; hitIdx=i; }
                }
                if(hitIdx>=0) damageEnemy(enemies[hitIdx], wp.damage);

                if (wp.uses === "ammo")   { player.ammo--;   if (player.ammo<=0)   player.weapon = player.shells>0 ? "shotgun" : "fists"; }
                if (wp.uses === "shells") { player.shells--; if (player.shells<=0) player.weapon = player.ammo>0   ? "pistol"  : "fists"; }

                player.fireCooldown = (active==="shotgun") ? 0.6 : (active==="fists" ? 0.25 : player.fireRate);
                weaponAnim = { state:"fire", t:0, duration:(active==="shotgun")?0.18:0.12, recoil:(active==="shotgun")?14:8 };
              } else {
                if (player.shells>0) player.weapon="shotgun";
                else if (player.ammo>0) player.weapon="pistol";
                else player.weapon="fists";
              }
            }
            if(weaponAnim.state==="fire"){ weaponAnim.t+=dt; if(weaponAnim.t>=weaponAnim.duration) weaponAnim.state="idle"; }

            if(player.hp<=0){ player.hp=0; endGame(false); }
          }
        }

        // cara
        if (face.timer>0){ face.timer = Math.max(0, face.timer - dt); if (face.timer===0) face.state="idle"; }
        if (player.hp<=30 && face.state!=="fire" && face.state!=="hurt") face.state="hurt";

        // disminuir flash rojo con el tiempo
        if (hitFlash > 0) hitFlash = Math.max(0, hitFlash - dt);

        // respiración
        updateBreath(now);

        // dibujar
        const hShift = (CAM.pitch * H * 0.45) | 0;
        drawFrame(hShift, now);
        rafId = requestAnimationFrame(tick);
      }

      function drawWalls(hShift){
        for(let x=0;x<W;x++){
          const rayA = player.a - player.fov/2 + (x/W)*player.fov;
          const r = castRayDDA(player.x, player.y, rayA);
          depthBuf[x] = r.dist;
          const hCol = Math.min(H, (H / r.dist) | 0);
          const y = ((H - hCol) >> 1) + hShift;
          const tex = TEX[r.tile];
          if (tex && tex.width){
            const srcX = Math.floor(r.u * tex.width) % tex.width;
            bctx.drawImage(tex, srcX, 0, 1, tex.height, x, y, 1, hCol);
            const shade = Math.min(0.7, r.dist/10 + (r.side?0.06:0));
            if (shade>0){ bctx.globalAlpha=shade; bctx.fillStyle="#000"; bctx.fillRect(x,y,1,hCol); bctx.globalAlpha=1; }
          } else {
            bctx.fillStyle = r.tile===3 ? "#4070b0" : (r.tile===2 ? "#c018c0" : "#b03020");
            bctx.fillRect(x,y,1,hCol);
          }
        }
      }

      function drawEnemyBillboard(e, size, sx, sy, x0, x1, distFix){
        let img;

        if (e.type === "boss") {
          if (e.state==="dead") {
            img = (e.dieFrame<0.5)?SPR.boss.die1:SPR.boss.die2;
          } else if (e.state==="hit") {
            img = SPR.boss.hit || SPR.boss.f2 || SPR.boss.f1;
          } else {
            // Anim segun movimiento: frente alterna f1/f2, laterales usan izq/der
            const mvAng = e.moveAng ?? e.dir;
            const toCam = Math.atan2(player.y - e.y, player.x - e.x);
            const rel = normAngle(toCam - mvAng);
            const deg = rel * 180/Math.PI;
            if (Math.abs(deg) <= 45) {
              img = (Math.sin(e.stepT)>=0)?(SPR.boss.f1||SPR.boss.f2):(SPR.boss.f2||SPR.boss.f1);
            } else if (deg > 45 && deg <= 135) {
              img = SPR.boss.left || SPR.boss.f1;
            } else if (deg < -45 && deg >= -135) {
              img = SPR.boss.right || SPR.boss.f1;
            } else {
              img = SPR.boss.back || SPR.boss.f1;
            }
          }
          if (!img || !img.width) return;

          // tamaño escalado del boss
          const sizeScaled = size * 1.6; // BOSS_SCALE por si querés exponerlo arriba
          const halfScaled = (sizeScaled / 2) | 0;
          const x0s = Math.max(0, (sx - halfScaled) | 0);
          const x1s = Math.min(W - 1, (sx + halfScaled) | 0);
          const syScaled = sy;

          for (let x = x0s; x <= x1s; x++) {
            if (distFix > depthBuf[x]) continue;
            const u = (x - (sx - halfScaled)) / (2 * halfScaled);
            const srcX = Math.floor(clampf(u, 0, 1) * (img.width - 1));
            bctx.drawImage(img, srcX, 0, 1, img.height, x, syScaled, 1, Math.floor(sizeScaled));
          }
          return;
        }

        if (e.type === "orc") {
          if (e.state==="dead") {
            img = (e.dieFrame<0.5)?SPR.orc.die1:SPR.orc.die2;
          } else if (e.state==="hit") {
            img = SPR.orc.front;
          } else {
            const angleEnemyToCam = Math.atan2(player.y - e.y, player.x - e.x);
            const rel = normAngle(angleEnemyToCam - (e.moveAng ?? e.dir));
            const deg = rel * 180/Math.PI;
            if (deg > -45 && deg <= 45) {
              img = (SPR.orc.frontWalk && Math.sin(e.stepT) < 0) ? SPR.orc.frontWalk : SPR.orc.front;
            } else if (deg > 45 && deg <= 135) img = SPR.orc.left;
            else if (deg <= -45 && deg > -135) img = SPR.orc.right;
            else img = SPR.orc.back;
          }
        } else if (e.type === "bola") {
          const angleEnemyToCam = Math.atan2(player.y - e.y, player.x - e.x);
          const rel = normAngle(angleEnemyToCam - (e.moveAng ?? e.dir));
          const deg = rel * 180/Math.PI;
          if (e.state==="dead") {
            img = SPR.bola.dead || SPR.bola.front || SPR.bola.back;
          } else {
            if (deg > -45 && deg <= 45)      img = SPR.bola.front || SPR.bola.right || SPR.bola.left || SPR.bola.back;
            else if (deg > 45 && deg <= 135) img = SPR.bola.left  || SPR.bola.front;
            else if (deg <= -45 && deg > -135) img = SPR.bola.right || SPR.bola.front;
            else                              img = SPR.bola.back  || SPR.bola.front;
          }
        } else {
          if (e.state==="dead")      img = (e.dieFrame<0.5)?SPR.demon.die1:SPR.demon.die2;
          else if (e.state==="hit")  img = (e.hitT>0.09)?SPR.demon.hit1:SPR.demon.hit2;
          else {
            const angleEnemyToCam = Math.atan2(player.y - e.y, player.x - e.x);
            const rel = normAngle(angleEnemyToCam - (e.moveAng ?? e.dir));
            const deg = rel * 180/Math.PI;
            if (deg > -45 && deg <= 45)      img = (Math.sin(e.stepT)>=0)?SPR.demon.frontL:SPR.demon.frontR;
            else if (deg > 45 && deg <= 135) img = SPR.demon.left;
            else if (deg <= -45 && deg > -135) img = SPR.demon.right;
            else                              img = SPR.demon.back;
          }
        }

        if (!img || !img.width) return;
        const half = (size/2)|0;
        const x0c = Math.max(0, Math.min(W-1, x0));
        const x1c = Math.max(0, Math.min(W-1, x1));
        for (let x=x0c;x<=x1c;x++){
          if (distFix > depthBuf[x]) continue;
          const u = (x - (sx - half)) / (2 * half);
          const srcX = Math.floor(clampf(u,0,1) * (img.width - 1));
          bctx.drawImage(img, srcX, 0, 1, img.height, x, sy, 1, Math.floor(size));
        }
      }

      function drawBossHP() {
        if (LEVEL !== 4) return;
        const boss = enemies.find(e=>e.type==="boss");
        if (!boss) return;
        const pct = clampf(boss.hp / BOSS_HP, 0, 1);

        const barW = 180, barH = 8;
        const x = (W - barW) >> 1, y = 6;
        bctx.fillStyle = "#000a"; bctx.fillRect(x-2, y-2, barW+4, barH+4);
        bctx.fillStyle = "#333";  bctx.fillRect(x, y, barW, barH);
        bctx.fillStyle = (pct <= 0.3) ? "#ff3b3b" : "#ffd24a";
        bctx.fillRect(x, y, Math.floor(barW * pct), barH);
        bctx.font = "bold 10px 'Roboto', monospace";
        bctx.fillStyle = "#fff";
        const t = "BOSS";
        const tw = bctx.measureText(t).width;
        bctx.fillText(t, ((W - tw)/2)|0, y + barH + 12);
      }

      function drawHUD(){
        const PANEL_H = 32, y0 = H - PANEL_H;

        if (HUD.panel && HUD.panel.width) {
          bctx.drawImage(HUD.panel, 0, y0, W, PANEL_H);
        } else {
          bctx.fillStyle="#101012"; bctx.fillRect(0,y0,W,PANEL_H);
          bctx.fillStyle="#0008"; bctx.fillRect(0,y0,W,PANEL_H);
        }

        const faceImg = face.state==="fire" ? HUD.face.fire :
                        face.state==="hurt" ? HUD.face.hurt :
                                              HUD.face.idle;
        if (faceImg && faceImg.width) {
          const fw=28, fh=28;
          bctx.drawImage(faceImg, 2, y0 + ((PANEL_H-fh)/2|0), fw, fh);
        }

        bctx.font="bold 12px 'Roboto', monospace";
        bctx.fillStyle = player.hp>30 ? "#fff83bff" : "#ec03fdff";
        bctx.fillText(String(player.hp|0).padStart(3," "), 40, y0+18);
        bctx.fillStyle="#ffffffff";
        const ammoShown = (player.weapon==="shotgun") ? player.shells : player.ammo;
        bctx.fillText(String(ammoShown|0).padStart(3," "), 92, y0+18);

        bctx.font="bold 10px 'Oswald', monospace"; bctx.fillStyle="#bbb";
        bctx.fillText("HEALTH", 40, y0+29);
        bctx.fillText("AMMO",   92, y0+29);

        const armsX = 140, armsY = y0+12;
        bctx.fillStyle="#bbb"; bctx.fillText("ARMS", armsX-4, y0+28);
        bctx.font="bold 12px 'Roboto', monospace";
        bctx.fillText("1", armsX, armsY);
        bctx.fillText("2", armsX+14, armsY);
        bctx.fillText("3", armsX+28, y0+12);

        bctx.font="bold 10px 'Roboto', monospace"; bctx.fillStyle="#fff";
        bctx.fillText(`DEMON ${killsDemons}/${WIN_DEMONS}`, W-150, y0+12);
        bctx.fillText(`ORC   ${killsOrcs}/${WIN_ORCS}`,     W-150, y0+22);
        bctx.fillStyle="#8f8";
        bctx.fillText(`PEDALS ${greens}/${WIN_GREENS}`,     W-150, y0+31);
      }
function drawMiniMap() {
  // Solo en nivel 4
  if (LEVEL !== 4) return;

  // Buscar jefe vivo
  const boss = enemies.find(e => e.type === "boss" && e.alive);
  if (!boss) return;

  const SIZE = 88;           // lado del mapa en px
  const PAD  = 6;            // margen al borde
  const x0 = W - SIZE - PAD; // esquina sup-der
  const y0 = PAD;

  const sx = SIZE / MAP_W;
  const sy = SIZE / MAP_H;

  // Panel y fondo
  bctx.fillStyle = "#000a";
  bctx.fillRect(x0 - 2, y0 - 2, SIZE + 4, SIZE + 4);
  bctx.fillStyle = "#0b0b0bcc";
  bctx.fillRect(x0, y0, SIZE, SIZE);

  // Paredes (chiquitas) para orientarse
  for (let y = 0; y < MAP_H; y++) {
    for (let x = 0; x < MAP_W; x++) {
      const t = cell(x, y);
      if (t > 0) {
        // mismos tonos que las paredes del nivel (sin exagerar)
        bctx.fillStyle = t === 3 ? "#4a78c9" : (t === 2 ? "#c018c0" : "#b03020");
        bctx.fillRect(x0 + x * sx, y0 + y * sy, sx, sy);
      }
    }
  }

  // Jugador: aro + flecha de dirección
  const px = x0 + player.x * sx;
  const py = y0 + player.y * sy;
  bctx.strokeStyle = "#ffea3a"; // amarillo
  bctx.lineWidth = 1;
  bctx.beginPath();
  bctx.arc(px, py, 3, 0, Math.PI * 2);
  bctx.stroke();
  const lookX = px + Math.cos(player.a) * 8;
  const lookY = py + Math.sin(player.a) * 8;
  bctx.beginPath();
  bctx.moveTo(px, py);
  bctx.lineTo(lookX, lookY);
  bctx.stroke();

  // Jefe: punto rojo
  const bx = x0 + boss.x * sx;
  const by = y0 + boss.y * sy;
  bctx.fillStyle = "#ff4343";
  bctx.beginPath();
  bctx.arc(bx, by, 3.2, 0, Math.PI * 2);
  bctx.fill();

  // Distancia (tiles) como feedback de cercanía
  const d = Math.hypot(boss.x - player.x, boss.y - player.y);
  bctx.font = "bold 9px 'Roboto', monospace";
  bctx.fillStyle = "#fff";
  bctx.fillText(`dist: ${d.toFixed(1)}`, x0 + 4, y0 + SIZE + 12);

  // Borde
  bctx.strokeStyle = "#ffffff";
  bctx.lineWidth = 1;
  bctx.strokeRect(x0, y0, SIZE, SIZE);
}

      function drawFrame(hShift, nowMs){
        const horizon = ((H/2)+hShift)|0;

        // TECHO
        if (CEIL_PATTERN) { bctx.fillStyle = CEIL_PATTERN; }
        else { bctx.fillStyle = "#1a1a1a"; }
        bctx.fillRect(0, 0, W, clampf(horizon,0,H));

        // PISO
        if (FLOOR_PATTERN) { bctx.fillStyle = FLOOR_PATTERN; }
        else {
          const grad=bctx.createLinearGradient(0,horizon,0,H);
          grad.addColorStop(0,"#151515"); grad.addColorStop(1,"#050505");
          bctx.fillStyle=grad;
        }
        bctx.fillRect(0, horizon, W, H - horizon);

        // PAREDES
        drawWalls(hShift);

        // sprites (enemigos, pickups, fireballs)
        const sprites=[];
        for (const e of enemies) sprites.push({x:e.x,y:e.y,ref:e,kind:"enemy",dist:dist(player.x,player.y,e.x,e.y)});
        for (const p of pickups) if(!p.taken) sprites.push({x:p.x,y:p.y,ref:p,kind:p.type,dist:dist(player.x,player.y,p.x,p.y)});
        for (const fb of projectiles) if (fb.alive) sprites.push({x:fb.x,y:fb.y,ref:fb,kind:"fireball",dist:dist(player.x,player.y,fb.x,fb.y)});
        sprites.sort((a,b)=>b.dist-a.dist);

        for(const s of sprites){
          const dx=s.x-player.x, dy=s.y-player.y;
          const ang = normAngle(Math.atan2(dy,dx) - player.a);
          if (Math.abs(ang) > player.fov/2 + 0.3) continue;
          const distFix = s.dist * Math.cos(ang);
          const size = Math.max(8, (H/distFix)|0);
          const sx = ((ang/player.fov)*W + W/2)|0;
          const sy = ((H/2 + hShift) - size/2)|0;
          const half=(size/2)|0, x0=Math.max(0,sx-half), x1=Math.min(W-1,sx+half);

          if(s.kind==="enemy"){
            drawEnemyBillboard(s.ref,size,sx,sy,x0,x1,distFix);
          } else if (s.kind==="fireball") {
            // ---- Bola amarilla con pulso ----
            // radio según distancia
            const r = Math.max(3, (size * 0.22) | 0);
            const cx = sx;
            const cy = sy + (size >> 1);

            // colores pulsantes (0.8..1.0) con dos frecuencias para variación
            const t = nowMs * 0.002;
            const pulse = 0.8 + 0.2 * Math.abs(Math.sin(t) * Math.cos(t*0.7));
            const core = Math.min(1, pulse + 0.1);

            // color borde
            bctx.fillStyle = `rgba(${Math.floor(255*pulse)}, ${Math.floor(210*pulse)}, 74, 1)`;
            const xStart = Math.max(0, cx - r);
            const xEnd   = Math.min(W - 1, cx + r);
            for (let x = xStart; x <= xEnd; x++) {
              if (distFix > depthBuf[x]) continue; // detrás de pared
              const dx = x - cx;
              const ySpan = Math.sqrt(r*r - dx*dx) | 0;
              const yTop  = (cy - ySpan) | 0;
              const hCol  = Math.max(1, ySpan * 2);
              bctx.fillRect(x, yTop, 1, hCol);
            }

            // núcleo brillante
            bctx.fillStyle = `rgba(255, ${Math.floor(240*core)}, 154, 1)`;
            const r2 = (r*0.55)|0;
            for (let x = Math.max(0, cx - r2); x <= Math.min(W-1, cx + r2); x++) {
              if (distFix > depthBuf[x]) continue;
              const dx = x - cx;
              const ySpan = Math.sqrt(r2*r2 - dx*dx) | 0;
              const yTop  = (cy - ySpan) | 0;
              const hCol  = Math.max(1, ySpan * 2);
              bctx.fillRect(x, yTop, 1, hCol);
            }
          } else {
            const img = PICKIMG[s.kind];
            if (img && img.width){
              for(let x=x0;x<=x1;x++){
                if(distFix>depthBuf[x]) continue;
                const u = (x-(sx-half))/(2*half);
                const srcX = Math.floor(clampf(u,0,1)*(img.width-1));
                const h = Math.max(6,(size*0.22)|0);
                const y = sy + size - h;
                bctx.drawImage(img, srcX, 0, 1, img.height, x, y, 1, h);
              }
            } else {
              for(let x=x0;x<=x1;x++){
                if(distFix>depthBuf[x]) continue;
                const h = Math.max(3,(size*0.18)|0);
                const y = sy + size - h;
                bctx.fillStyle = s.kind==="ammo"?"#ffe36b": s.kind==="health"?"#e33": s.kind==="shells"?"#ffa500":"#3f6";
                bctx.fillRect(x,y,1,h);
              }
            }
          }
        }

        // arma FP
        drawWeapon(hShift);

        // HUD + barra boss
        drawHUD();
        drawBossHP();
        drawMiniMap();

        // Flash rojo
        if (hitFlash > 0) {
          const k = hitFlash / HIT_FLASH_TIME;
          bctx.globalAlpha = 0.55 * k;
          bctx.fillStyle = "#f00";
          bctx.fillRect(0, 0, W, H);
          bctx.globalAlpha = 1;
        }

        // mira
        const cx=(W/2)|0, cy=((H/2)+hShift)|0;
        bctx.fillStyle="#ff2"; bctx.fillRect(cx-1,cy,2,1); bctx.fillRect(cx,cy-1,1,2);

        // overlays
        if (gameState==="levelcomplete"){
          bctx.fillStyle="#000a"; bctx.fillRect(0,0,W,H);
          bctx.fillStyle="#6f6"; bctx.font="bold 16px 'Roboto', monospace";
          const isLast = (LEVEL>=4);
          const txt = isLast ? "¡HAS VENCIDO AL JEFE!" : `¡NIVEL ${LEVEL} COMPLETADO!`;
          const wTxt=bctx.measureText(txt).width; bctx.fillText(txt, ((W-wTxt)/2)|0, (H/2-8)|0);
          bctx.font="bold 10px 'Roboto', monospace";
          const msg = isLast ? "Enter para volver al nivel 1" : "Enter para continuar";
          const wMsg=bctx.measureText(msg).width; bctx.fillText(msg, ((W-wMsg)/2)|0, (H/2+10)|0);
        }
        if (gameOver && gameState==="gameover"){
          bctx.fillStyle="#000a"; bctx.fillRect(0,0,W,H);
          bctx.fillStyle="#f66"; bctx.font="bold 16px 'Roboto', monospace";
          const txt = "GAME OVER";
          const wTxt=bctx.measureText(txt).width; bctx.fillText(txt, ((W-wTxt)/2)|0, (H/2-8)|0);
          bctx.font="bold 10px 'Roboto', monospace"; const msg="Enter para reiniciar";
          const wMsg=bctx.measureText(msg).width; bctx.fillText(msg, ((W-wMsg)/2)|0, (H/2+10)|0);
        }

        ctx.drawImage(back,0,0,canvas.width,canvas.height);
      }

      function drawWeapon(hShift){
        const wp = WEAPON[player.weapon] || WEAPON.fists;
        const img = (weaponAnim.state==="fire" ? wp.fire : wp.idle);
        if (!img || !img.width) return;

        const paramsByWeapon = {
          fists:   { scale: 1.00, offX: -4,  offY: 0,  center: false },
          pistol:  { scale: 1.00, offX: -4,  offY: 0,  center: false },
          shotgun: { scale: 1.10, offX:  0,  offY: 10, center: true  },
        };
        const P = paramsByWeapon[player.weapon] || paramsByWeapon.fists;

        const wBase = W * 0.45 * P.scale;
        const wGun  = Math.floor(wBase);
        const hGun  = Math.floor(wGun * (img.height / img.width));

        let xGun = P.center ? Math.floor((W - wGun) / 2) : Math.floor(W - wGun - 4);
        xGun += P.offX;

        let yGun = H - hGun - 2 + P.offY + (((CAM.pitch * H * 0.45) | 0) * 0.35) | 0;

        if(weaponAnim.state==="fire"){
          const k=Math.sin((weaponAnim.t/weaponAnim.duration)*Math.PI);
          yGun += k * (player.weapon==="shotgun" ? 14 : 8);
        }
        bctx.drawImage(img, xGun, yGun, wGun, hGun);
      }

      function drawTitle(){
        bctx.fillStyle = "#000"; bctx.fillRect(0,0,W,H);
        if (HUD.cover && HUD.cover.width) {
          bctx.drawImage(HUD.cover, 0, 0, W, H);
          bctx.fillStyle = "#0008"; bctx.fillRect(0, H-30, W, 30);
        }
        bctx.font = "bold 14px 'Roboto', monospace";
        bctx.fillStyle="#fff";
        const msg = "PRESS ENTER TO PLAY  •  F5 REINICIAR";
        const wMsg = bctx.measureText(msg).width;
        bctx.fillText(msg, ((W-wMsg)/2)|0, H-12);

        ctx.drawImage(back,0,0,canvas.width,canvas.height);
      }

      function drawFinalScreen(){
        bctx.fillStyle = "#000"; bctx.fillRect(0,0,W,H);
        if (HUD.final && HUD.final.width) {
          bctx.drawImage(HUD.final, 0, 0, W, H);
        } else {
          bctx.font = "bold 18px 'Roboto', monospace";
          bctx.fillStyle="#fff";
          const txt="FINAL DEL JUEGO";
          const wt=bctx.measureText(txt).width;
          bctx.fillText(txt, ((W-wt)/2)|0, (H/2)|0);
        }
        bctx.font = "bold 12px 'Roboto', monospace";
        bctx.fillStyle="#ffd24a";
        const msg="Enter para reiniciar  •  F5 recargar";
        const wm=bctx.measureText(msg).width;
        bctx.fillText(msg, ((W-wm)/2)|0, H-10);

        ctx.drawImage(back,0,0,canvas.width,canvas.height);
      }

      // Cleanup robusto
      cleanup = () => {
        try { MUSIC.dispose(); } catch {}
        if (rafId) cancelAnimationFrame(rafId);
        window.removeEventListener("keydown", onDown);
        window.removeEventListener("keyup", onUp);
        window.removeEventListener("mousemove", onMouseMove);
        window.removeEventListener("mousedown", onMouseDown);
        window.removeEventListener("mouseup", onMouseUp);
        canvas.removeEventListener("click", togglePointerLock);
      };
    });

    // Cleanup general
    return () => {
      if (typeof cleanup === "function") cleanup();
    };
  }, []);

  return (
    <div style={{ position:"relative" }}>
      <canvas ref={canvasRef} style={{ border:"1px solid #000", outline: "none" }} />
      <div style={{ position:"absolute", top:8, left:8, color:"#bbb", fontFamily:"'Roboto', monospace", fontSize:12 }}>
        WASD moverse • Q/E girar • Mouse mira • Click disparar • 1 puños • 2 pistola • 3 escopeta • Z spawn • Enter • F5 reiniciar juego
      </div>
    </div>
  );
}
