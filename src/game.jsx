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
    // title | playing | levelcomplete | gameover
    let gameState = "title";
    let LEVEL = 1, MAX_LEVELS = 3;

    /* ---------- Juego / mapa ---------- */
    const MAX_ENEMIES = 60, SPAWN_EVERY = 1.3, INITIAL_ENEMIES = 6;

    let MAP_W = 32, MAP_H = 24;
    function makeMap(w,h, density=0.06){
      const A = new Array(w*h).fill(0);
      for (let x=0;x<w;x++){ A[x]=1; A[(h-1)*w+x]=1; }
      for (let y=0;y<h;y++){ A[y*w]=1; A[y*w+w-1]=1; }
      const blocks = Math.floor(w*h*density);
      for (let i=0;i<blocks;i++){
        const x = 2 + Math.floor(Math.random()*(w-4));
        const y = 2 + Math.floor(Math.random()*(h-4));
        const t = Math.random()<0.5?1:2;
        if (Math.random()<0.5) for(let k=-1;k<=1;k++) A[y*w+(x+k)] = t;
        else                    for(let k=-1;k<=1;k++) A[(y+k)*w+x] = t;
      }
      return A;
    }
    let MAP = makeMap(MAP_W, MAP_H);
    const idx=(x,y)=>(y|0)*MAP_W+(x|0);
    const cell=(x,y)=>(x<0||y<0||x>=MAP_W||y>=MAP_H)?1:MAP[idx(x,y)];

    // Helpers de colisión con paredes (mobs)
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

    const player = {
      x: 3.5, y: MAP_H-2.5, a: -Math.PI/2, fov: Math.PI/3,
      speed: 2.0, rotSpeed: 2.2,
      hp: 100,
      weapon: "pistol",   // fists | pistol | shotgun
      ammo: 24,           // balas de pistola
      shells: 0,          // cartuchos escopeta
      fireCooldown: 0, fireRate: 0.22,
    };

    // victoria: 30 demon + 15 orc  (y greens>=10)
    const WIN_DEMONS = 1, WIN_ORCS = 0, WIN_GREENS = 10;
    let killsDemons = 0, killsOrcs = 0, greens = 0;
    let gameOver = false, win = false;

    /* ---------- Enemigos ---------- */
    const enemies = [];
    const ENEMY_SPEED = 0.75;                   // base demon/orc
    const BOLA_SPEED  = ENEMY_SPEED * 2.0;      // bola = doble
    const TOUCH_DMG_NORMAL = 10;
    const TOUCH_DMG_BOLA   = TOUCH_DMG_NORMAL * 2; // bola = doble
    const CONTACT_DPS = 25;
    const BACKOFF_DIST = 0.4, BACKOFF_TIME = 0.5, TOUCH_COOLDOWN = 0.6;

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
        type,
      };
    }

    /* ---------- Pickups ---------- */
    const pickups=[];
    function randomSpawnPos(min=6){
      for(let t=0;t<100;t++){
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
      // spawn “exclusivo” de la bola
      bolaSpawn:    makeSfx("/sfx/bola_spawn.wav", 0.8),
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
    const handledKeys = new Set(["KeyW","KeyA","KeyS","KeyD","KeyQ","KeyE","Digit1","Digit2","Digit3","Enter"]);
    const onKey = (e,down)=>{
      if (handledKeys.has(e.code)) e.preventDefault();

      if (down && e.code==="Enter" && gameState==="title") { startGame(); return; }
      if (gameState==="levelcomplete" && down && e.code==="Enter"){ nextLevel(); return; }
      if (gameOver && down && e.code==="Enter"){ resetGame(); return; }

      if (down && gameState==="playing") {
        if (e.code==="Digit1") player.weapon="fists";
        if (e.code==="Digit2") { if (player.ammo>0)   player.weapon="pistol"; }
        if (e.code==="Digit3") { if (player.shells>0) player.weapon="shotgun"; }
        if (e.code==="KeyZ"){
          const p=randomSpawnPos(5);
          if(p && enemies.length<MAX_ENEMIES){
            const wasEmpty = enemies.length===0;
            const ne = makeEnemy(p.x,p.y); // puede ser bola
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
    // TEX variará por nivel
    const TEX = { 1:null, 2:null };
    const WEAPON = {
      fists:   { idle:null, fire:null, damage:15, uses:null       },
      pistol:  { idle:null, fire:null, damage:25, uses:"ammo"     },
      shotgun: { idle:null, fire:null, damage:50, uses:"shells"   },
    };

    const SPR = {
      demon: { frontL:null, frontR:null, back:null, left:null, right:null, hit1:null, hit2:null, die1:null, die2:null },
      orc:   { front:null, frontWalk:null, back:null, left:null, right:null, die1:null, die2:null },
      bola:  { front:null, left:null, right:null, back:null, dead:null } // bola con sprite muerto
    };

    const PICKIMG = { ammo:null, health:null, green:null, shells:null };
    const HUD = { panel:null, face:{ idle:null, fire:null, hurt:null }, cover:null };

    // Cara estilo Doom
    const face = { state:"idle", timer:0, FIRE_TIME:0.25, HURT_TIME:0.6 };
    const setFaceState = (s,t=0)=>{ face.state=s; face.timer=t; };

    // ---- Flash rojo al recibir daño ----
    let hitFlash = 0;
    const HIT_FLASH_TIME = 0.25;

    // Texturas por nivel
    const TEXSETS = {
      1: { t1: "brick_red",  t2: "brick_pink"  },
      2: { t1: "mosaico3",   t2: "mosaico4"    },
      3: { t1: "mosaico4jpg", t2: "mosaico5jpg" }, // << nivel 3 con JPGs nuevos
    };
    function applyTexturesForLevel(images) {
      const set = TEXSETS[LEVEL] || TEXSETS[1];
      TEX[1] = images[set.t1] || null;
      TEX[2] = images[set.t2] || null;
    }

    // Piso y techo (pattern cacheados)
    let FLOOR_IMG = null, CEIL_IMG = null;
    let FLOOR_PATTERN = null, CEIL_PATTERN = null;

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
      // BOLA (nuevo)
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
      loadImage("/sprites/mosaico-3.jpg").catch(()=>null),
      loadImage("/sprites/mosaico-44.jpg").catch(()=>null),
      // nuevas paredes nivel 3 (JPG)
      loadImage("/sprites/mosaico-4.jpg").catch(()=>null),
      loadImage("/sprites/mosaico-5.jpg").catch(()=>null),
      // PISO y TECHO
      loadImage("/sprites/piso.png").catch(()=>null),
      loadImage("/sprites/techo.jpg").catch(()=>null),
      // HUD + portada
      loadImage("/sprites/hud/panel.jpg").catch(()=>null),
      loadImage("/sprites/hud/face-normal.png").catch(()=>null),
      loadImage("/sprites/hud/face-sadic.png").catch(()=>null),
      loadImage("/sprites/hud/face-pain.png").catch(()=>null),
      loadImage("/sprites/freepik__agregar-ondo__55653.png").catch(()=>null),
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
      // piso/techo
      pisoImg, techoImg,
      // HUD
      hudPanel, faceIdle, faceFire, faceHurt, coverImg
    ])=>{
      // demon
      SPR.demon.frontL=d_frI; SPR.demon.frontR=d_frD; SPR.demon.back=d_back; SPR.demon.left=d_left; SPR.demon.right=d_right;
      SPR.demon.hit1=d_hit1; SPR.demon.hit2=d_hit2; SPR.demon.die1=d_die1; SPR.demon.die2=d_die2;
      // orc
      SPR.orc.front=o_front; SPR.orc.frontWalk=o_frontWalk; SPR.orc.back=o_back; SPR.orc.left=o_left; SPR.orc.right=o_right; SPR.orc.die1=o_die1; SPR.orc.die2=o_die2;
      // bola
      SPR.bola.front=b_front||null; SPR.bola.left=b_left||null; SPR.bola.right=b_right||null; SPR.bola.back=b_back||null; SPR.bola.dead=b_dead||null;

      // armas
      WEAPON.fists.idle=fistsIdle||null;   WEAPON.fists.fire=fistsFire||fistsIdle||null;
      WEAPON.pistol.idle=gunIdle||null;    WEAPON.pistol.fire=gunFire||gunIdle||null;
      WEAPON.shotgun.idle=shIdle||null;    WEAPON.shotgun.fire=shFire||shIdle||null;

      // pickups
      PICKIMG.ammo=pngAmmo||null; PICKIMG.health=pngHeart||null; PICKIMG.green=pngGreen||null; PICKIMG.shells=pngShells||null;

      // Guardamos todas las texturas disponibles por nombre
      const allTex = {
        brick_red: brickRed || null,
        brick_pink: brickPink || null,
        mosaico3: mosaico3 || null,
        mosaico4: mosaico4 || null,
        mosaico4jpg: mosaico4jpg || null,
        mosaico5jpg: mosaico5jpg || null,
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

      // arrancamos en pantalla de título
      drawTitle();
      requestAnimationFrame(tick);

      // ---- helpers de nivel dentro del scope de assets ----
  // ---- helpers de nivel dentro del scope de assets ----
nextLevel = function() {
  LEVEL = LEVEL < MAX_LEVELS ? LEVEL + 1 : 1; // si pasa el 3 vuelve al 1
  const dens = LEVEL===1 ? 0.06 : LEVEL===2 ? 0.08 : 0.10;
  MAP = makeMap(MAP_W, MAP_H, dens);
  applyTexturesForLevel(allTex);
  resetGameCore();
  gameState = "playing";
};


      function resetGameCore() {
        Object.assign(player, { x:3.5, y:MAP_H-2.5, a:-Math.PI/2, hp:100, ammo:24, shells:0, weapon:"pistol", fireCooldown:0 });
        CAM.pitch=0; killsDemons=0; killsOrcs=0; greens=0; gameOver=false; win=false; face.state="idle"; face.timer=0;
        hitFlash = 0;

        enemies.length=0;
        for (let i=0;i<INITIAL_ENEMIES;i++){
          const p = randomSpawnPos(5) || { x:6.5, y:MAP_H-6.5 };
          enemies.push(makeEnemy(p.x,p.y));
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
        MUSIC.play();
        resetGameCore();
        canvas.focus();
        gameState = "playing";
      };

      resetGame = function(){
        // Reinicia el mismo nivel actual
        applyTexturesForLevel(allTex);
        const dens = LEVEL===1 ? 0.06 : LEVEL===2 ? 0.08 : 0.10;
        MAP = makeMap(MAP_W, MAP_H, dens);
        resetGameCore();
        gameState = "playing";
      };

      endGame = function(v){
        gameOver = true; win=v;
        gameState = v ? "levelcomplete" : "gameover";
      };

      // expone nextLevel al cierre superior (no es obligatorio)
      _helpers.nextLevel = nextLevel;
    });

    /* ---------- Anim arma ---------- */
    let weaponAnim = { state:"idle", t:0, duration:0, recoil:0 };

    // placeholders que serán reemplazados cuando haya assets
let startGame = ()=>{};
let resetGame = ()=>{};
let endGame   = ()=>{};
let nextLevel = ()=>{};   // <--- AGREGAR ESTA LÍNEA
const _helpers = {};
    /* ---------- Loop ---------- */
    let last = performance.now();
    const depthBuf = new Float32Array(W);
    let spawnTimer = 0;

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
      if(e.hp<=0){
        e.alive=false; e.state="dead"; e.dieFrame=0;
        if (e.type === "orc") killsOrcs++;
        else if (e.type==="demon") killsDemons++;
        // bola no cuenta para esos contadores (queda igual que antes)
        SFX.enemyDie();
        if(!gameOver && ((killsDemons>=WIN_DEMONS && killsOrcs>=WIN_ORCS) || greens>=WIN_GREENS)) endGame(true);
      } else { e.state="hit"; e.hitT=0.18; }
    }

    function tick(now){
      const dt = Math.min(0.05, (now-last)/1000); last=now;

      if (gameState === "title") {
        drawTitle();
        requestAnimationFrame(tick);
        return;
      }

      if(!gameOver || gameState==="levelcomplete"){
        // movimiento jugador (solo en playing)
        if (gameState==="playing"){
          const forward=(keys.KeyW?1:0)-(keys.KeyS?1:0);
          const strafe =(keys.KeyD?1:0)-(keys.KeyA?1:0);
          const rot    =(keys.KeyE?1:0)-(keys.KeyQ?1:0);
          player.a += rot*player.rotSpeed*dt;
          const cs=Math.cos(player.a), sn=Math.sin(player.a);
          tryMove(player.x + (cs*forward - sn*strafe)*player.speed*dt,
                  player.y + (sn*forward + cs*strafe)*player.speed*dt);

          // spawns automáticos
          spawnTimer += dt;
          if (spawnTimer >= SPAWN_EVERY && enemies.length < MAX_ENEMIES) {
            const p = randomSpawnPos(7);
            if (p) {
              const wasEmpty=enemies.length===0;
              const ne = makeEnemy(p.x,p.y); // random (incluye bola)
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

            // Daño por toque (cooldown)
            const d = dist(player.x,player.y,e.x,e.y);
            if (d < 0.6 && e.touchCd <= 0) {
              const touch = (e.type==="bola") ? TOUCH_DMG_BOLA : TOUCH_DMG_NORMAL;
              player.hp = Math.max(0, player.hp - touch);
              setFaceState("hurt", face.HURT_TIME);
              hitFlash = HIT_FLASH_TIME;
              SFX.hurt();

              e.touchCd = TOUCH_COOLDOWN;
              e.backOffT = BACKOFF_TIME;
              const away = Math.atan2(e.y - player.y, e.x - player.x);
              const bx = Math.cos(away) * BACKOFF_DIST;
              const by = Math.sin(away) * BACKOFF_DIST;
              slideMoveEntity(e, bx, by);
            }
          }

          // anti-apilado
          separateEnemies();

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
      drawFrame(hShift);
      requestAnimationFrame(tick);
    }

    /* ---------- Dibujo ---------- */
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
          bctx.fillStyle = r.tile===2 ? "#c018c0" : "#b03020";
          bctx.fillRect(x,y,1,hCol);
        }
      }
    }

    function drawEnemyBillboard(e, size, sx, sy, x0, x1, distFix){
      let img;
      if (e.type === "orc") {
        if (e.state==="dead") {
          img = (e.dieFrame<0.5)?SPR.orc.die1:SPR.orc.die2;
        } else if (e.state==="hit") {
          img = SPR.orc.front;
        } else {
          const angleEnemyToCam = Math.atan2(player.y - e.y, player.x - e.x);
          const rel = normAngle(angleEnemyToCam - e.dir);
          const deg = rel * 180/Math.PI;
          if (deg > -45 && deg <= 45) {
            img = (SPR.orc.frontWalk && Math.sin(e.stepT) < 0) ? SPR.orc.frontWalk : SPR.orc.front;
          } else if (deg > 45 && deg <= 135) img = SPR.orc.left;
          else if (deg <= -45 && deg > -135) img = SPR.orc.right;
          else img = SPR.orc.back;
        }
      } else if (e.type === "bola") {
        const angleEnemyToCam = Math.atan2(player.y - e.y, player.x - e.x);
        const rel = normAngle(angleEnemyToCam - e.dir);
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
          const rel = normAngle(angleEnemyToCam - e.dir);
          const deg = rel * 180/Math.PI;
          if (deg > -45 && deg <= 45)      img = (Math.sin(e.stepT)>=0)?SPR.demon.frontL:SPR.demon.frontR;
          else if (deg > 45 && deg <= 135) img = SPR.demon.left;
          else if (deg <= -45 && deg > -135) img = SPR.demon.right;
          else                              img = SPR.demon.back;
        }
      }

      if (!img || !img.width) return;
      const half = (size/2)|0;
      for (let x=x0;x<=x1;x++){
        if (distFix > depthBuf[x]) continue;
        const u = (x - (sx - half)) / (2 * half);
        const srcX = Math.floor(clampf(u,0,1) * (img.width - 1));
        bctx.drawImage(img, srcX, 0, 1, img.height, x, sy, 1, Math.floor(size));
      }
    }

    function drawHUD(){
      const PANEL_H = 32, y0 = H - PANEL_H;

      if (HUD.panel && HUD.panel.width) {
        bctx.drawImage(HUD.panel, 0, y0, W, PANEL_H);
      } else {
        bctx.fillStyle="#101012"; bctx.fillRect(0,y0,W,PANEL_H);
        bctx.fillStyle="#0008"; bctx.fillRect(0,y0,W,PANEL_H);
      }

      // Cara
      const faceImg = face.state==="fire" ? HUD.face.fire :
                      face.state==="hurt" ? HUD.face.hurt :
                                            HUD.face.idle;
      if (faceImg && faceImg.width) {
        const fw=28, fh=28;
        bctx.drawImage(faceImg, 2, y0 + ((PANEL_H-fh)/2|0), fw, fh);
      }

      // HEALTH y AMMO grandes
      bctx.font="bold 12px 'Roboto', monospace";
      bctx.fillStyle = player.hp>30 ? "#fff83bff" : "#ec03fdff";
      bctx.fillText(String(player.hp|0).padStart(3," "), 40, y0+18);
      bctx.fillStyle="#ffffffff";
      const ammoShown = (player.weapon==="shotgun") ? player.shells : player.ammo;
      bctx.fillText(String(ammoShown|0).padStart(3," "), 92, y0+18);

      // Labels
      bctx.font="bold 10px 'Oswald', monospace"; bctx.fillStyle="#bbb";
      bctx.fillText("HEALTH", 40, y0+29);
      bctx.fillText("AMMO",   92, y0+29);

      // ARMS: 1/2/3
      const armsX = 140, armsY = y0+12;
      bctx.fillStyle="#bbb"; bctx.fillText("ARMS", armsX-4, y0+28);
      bctx.font="bold 12px 'Roboto', monospace";
      bctx.fillText("1", armsX, armsY);
      bctx.fillText("2", armsX+14, armsY);
      bctx.fillText("3", armsX+28, y0+12);

      // Contadores a la derecha
      bctx.font="bold 10px 'Roboto', monospace"; bctx.fillStyle="#fff";
      bctx.fillText(`DEMON ${killsDemons}/${WIN_DEMONS}`, W-150, y0+12);
      bctx.fillText(`ORC   ${killsOrcs}/${WIN_ORCS}`,     W-150, y0+22);
      bctx.fillStyle="#8f8";
      bctx.fillText(`PEDALS ${greens}/${WIN_GREENS}`,     W-150, y0+31);
    }

    function drawFrame(hShift){
      // Línea de horizonte con pitch
      const horizon = ((H/2)+hShift)|0;

      // ==== TECHO (pattern) ====
      if (CEIL_PATTERN) {
        bctx.fillStyle = CEIL_PATTERN;
      } else {
        bctx.fillStyle = "#1a1a1a";
      }
      bctx.fillRect(0, 0, W, clampf(horizon,0,H));

      // ==== PISO (pattern) ====
      if (FLOOR_PATTERN) {
        bctx.fillStyle = FLOOR_PATTERN;
      } else {
        // fallback degradado suave si no hay textura
        const grad=bctx.createLinearGradient(0,horizon,0,H);
        grad.addColorStop(0,"#151515"); grad.addColorStop(1,"#050505");
        bctx.fillStyle=grad;
      }
      bctx.fillRect(0, horizon, W, H - horizon);

      // PAREDES
      drawWalls(hShift);

      // sprites (enemigos + pickups)
      const sprites=[];
      for (const e of enemies) sprites.push({x:e.x,y:e.y,ref:e,kind:"enemy",dist:dist(player.x,player.y,e.x,e.y)});
      for (const p of pickups) if(!p.taken) sprites.push({x:p.x,y:p.y,ref:p,kind:p.type,dist:dist(player.x,player.y,p.x,p.y)});
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

      // HUD
      drawHUD();

      // ---- Flash rojo por daño ----
      if (hitFlash > 0) {
        const k = hitFlash / HIT_FLASH_TIME; // 1..0
        bctx.globalAlpha = 0.55 * k;
        bctx.fillStyle = "#f00";
        bctx.fillRect(0, 0, W, H);
        bctx.globalAlpha = 1;
      }

      // mira
      const cx=(W/2)|0, cy=((H/2)+hShift)|0;
      bctx.fillStyle="#ff2"; bctx.fillRect(cx-1,cy,2,1); bctx.fillRect(cx,cy-1,1,2);

      // overlays de fin/nivel
      if (gameState==="levelcomplete"){
        bctx.fillStyle="#000a"; bctx.fillRect(0,0,W,H);
        bctx.fillStyle="#6f6"; bctx.font="bold 16px 'Roboto', monospace";
        const txt = `¡NIVEL ${LEVEL} COMPLETADO!`;
        const wTxt=bctx.measureText(txt).width; bctx.fillText(txt, ((W-wTxt)/2)|0, (H/2-8)|0);
        bctx.font="bold 10px 'Roboto', monospace";
        const isLast = (LEVEL>=3);
        const msg = isLast ? "Enter para volver a empezar" : "Enter para continuar";
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
      const msg = "PRESS ENTER TO PLAY";
      const wMsg = bctx.measureText(msg).width;
      bctx.fillText(msg, ((W-wMsg)/2)|0, H-12);

      ctx.drawImage(back,0,0,canvas.width,canvas.height);
    }

    // Cleanup (evita leaks en dev/StrictMode)
    return () => {
      try { MUSIC.dispose(); } catch {}
      window.removeEventListener("keydown", onDown);
      window.removeEventListener("keyup", onUp);
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mousedown", onMouseDown);
      window.removeEventListener("mouseup", onMouseUp);
      canvas.removeEventListener("click", togglePointerLock);
    };
  }, []);

  return (
    <div style={{ position:"relative" }}>
      <canvas ref={canvasRef} style={{ border:"1px solid #000", outline: "none" }} />
      <div style={{ position:"absolute", top:8, left:8, color:"#bbb", fontFamily:"'Roboto', monospace", fontSize:12 }}>
        WASD moverse • Q/E girar • Mouse mira • Click disparar • 1 puños • 2 pistola • 3 escopeta • Z spawn • Enter
      </div>
    </div>
  );
}
