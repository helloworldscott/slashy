const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');

class TileMap {
  constructor(w, h) {
    this.w = w;
    this.h = h;
    this.tiles = [];
    for (let y = 0; y < h; y++) {
      const row = [];
      for (let x = 0; x < w; x++) row.push(this.makeTile('street'));
      this.tiles.push(row);
    }
  }
  makeTile(type) {
    return {
      type,
      blocked: false,
      hide: false,
      interact: null,
      exit: false,
      vaultTo: null,
      height: 0,
      lowWall: false,
      deco: null,
    };
  }
  inBounds(x, y) { return x >= 0 && y >= 0 && x < this.w && y < this.h; }
  get(x, y) { return this.inBounds(x, y) ? this.tiles[y][x] : null; }
}

class Game {
  constructor() {
    this.tileW = 64;
    this.tileH = 32;
    this.map = this.makeLevel();
    this.playerStart = { x: 2, y: 12 };
    this.killerStart = { x: 10, y: 3 };
    this.exitPos = { x: 13, y: 1 };
    this.keySpawnPos = { x: 14, y: 13 };
    this.reset();
    this.bindUI();
    this.resize();
    window.addEventListener('resize', () => this.resize());
    canvas.addEventListener('mousemove', (e) => this.onMouseMove(e));
    canvas.addEventListener('click', (e) => this.onClick(e));
    window.addEventListener('keydown', (e) => this.onKey(e));
    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      const d = Math.sign(e.deltaY);
      this.camera.zoom = Math.max(0.6, Math.min(1.8, this.camera.zoom - d * 0.08));
    }, { passive: false });
    requestAnimationFrame((t) => this.loop(t));
  }

  reset() {
    this.state = 'start';
    this.turn = 'player';
    this.ap = 2;
    this.maxAp = 2;
    this.hp = 2;
    this.player = { ...this.playerStart, hidden: false, injured: false, selected: true, anim: null };
    this.killer = { ...this.killerStart, state: 'PATROL', ap: 2, patrolIndex: 0, lastSeen: null, heard: null, suspicion: 0, anim: null };
    this.noisePings = [];
    this.hasExitKey = false;
    this.keySpawned = false;
    this.log = [];
    this.hover = null;
    this.reachable = new Set();
    this.path = [];
    this.sprintMode = false;
    this.turnBusy = false;
    this.autoPlay = false;
    this.firstSighting = false;
    this.shake = 0;
    this.combatBanner = { text: '', t: 0, strong: false };
    this.camera = { x: 0, y: 0, targetX: 0, targetY: 0, zoom: 1 };
    this.sound = { muted: false, ctx: null };
    this.centerOn(this.player.x, this.player.y, true);
    this.setReachable();
    this.pushLog('Find a way out. The gate may need more than courage.');
    this.updateHUD();
  }

  makeLevel() {
    const map = new TileMap(16, 16);
    for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
      const t = map.get(x, y);
      t.height = (x > 7 && y < 8) ? 1 : 0;
      if (x === 0 || y === 0 || x === 15 || y === 15) { t.type = 'hedge'; t.blocked = true; }
    }
    const blockRect = (x0, y0, x1, y1, type='wall') => {
      for (let y=y0;y<=y1;y++) for(let x=x0;x<=x1;x++){ const t=map.get(x,y); t.type=type; t.blocked=true; t.height=1; }
    };
    blockRect(3,3,6,6,'house');
    blockRect(9,9,13,12,'house');
    blockRect(1,8,1,13,'fence');
    blockRect(7,2,7,7,'fence');
    blockRect(11,4,14,4,'hedge');

    const setStreet=(x,y)=>{ const t=map.get(x,y); if(!t)return; t.type='street'; t.blocked=false; };
    [[1,10],[1,11],[1,12],[7,4],[7,5],[7,6],[12,4],[13,4],[14,4],[4,6],[5,6],[6,6],[10,9],[11,9],[12,9],[13,9]].forEach(([x,y])=>setStreet(x,y));

    map.get(2,9).interact = 'vault'; map.get(2,9).lowWall = true; map.get(2,9).vaultTo = {x:2,y:8};
    map.get(8,6).interact = 'vault'; map.get(8,6).lowWall = true; map.get(8,6).vaultTo = {x:7,y:6};
    map.get(14,2).interact = 'alarm';
    map.get(4,10).interact = 'alarm';
    map.get(13,1).exit = true; map.get(13,1).interact = 'exit'; map.get(13,1).deco='gate';

    map.get(2,13).hide = true; map.get(2,13).deco='bush';
    map.get(6,8).hide = true; map.get(6,8).deco='dumpster';
    map.get(12,13).hide = true; map.get(12,13).deco='closet';
    [[5,2],[10,2],[3,11],[9,6],[14,10]].forEach(([x,y])=>map.get(x,y).deco='lamp');

    return map;
  }

  bindUI() {
    const byId = id => document.getElementById(id);
    byId('startBtn').onclick = () => this.showStart();
    byId('restartBtn').onclick = () => this.restart();
    byId('centerBtn').onclick = () => this.centerOn(this.player.x, this.player.y);
    byId('muteBtn').onclick = () => { this.sound.muted = !this.sound.muted; byId('muteBtn').textContent = `Mute: ${this.sound.muted ? 'On' : 'Off'}`; };
    byId('endTurnBtn').onclick = () => this.tryEndTurn();
    byId('interactBtn').onclick = () => this.interact();
    byId('hideBtn').onclick = () => this.hideAction();
    byId('sprintBtn').onclick = () => { this.sprintMode = !this.sprintMode; this.pushLog(`Sprint ${this.sprintMode ? 'armed' : 'off'}.`); };
    byId('helpBtn').onclick = () => this.showOnly('helpScreen');
    byId('closeHelpBtn').onclick = () => this.hideOverlay();
    byId('beginRunBtn').onclick = () => { this.hideOverlay(); this.state='playing'; };
    document.querySelectorAll('.replayBtn').forEach(b=>b.onclick=()=>this.restart());
  }

  resize() {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
  }

  gridToScreen(x,y,h=0){
    const sx = (x - y) * (this.tileW / 2);
    const sy = (x + y) * (this.tileH / 2) - h * 18;
    return { x: sx, y: sy };
  }
  screenToGrid(px,py){
    const x = ((px/(this.tileW/2)) + (py/(this.tileH/2))) /2;
    const y = ((py/(this.tileH/2)) - (px/(this.tileW/2))) /2;
    return { x: Math.floor(x+0.5), y: Math.floor(y+0.5) };
  }

  worldMouse(e){
    const rect=canvas.getBoundingClientRect();
    let mx=(e.clientX-rect.left-this.camera.x)/this.camera.zoom;
    let my=(e.clientY-rect.top-this.camera.y)/this.camera.zoom;
    return this.screenToGrid(mx,my);
  }

  onMouseMove(e){ this.hover = this.worldMouse(e); }
  onClick(e){
    if (this.state!=='playing' || this.turn!=='player' || this.turnBusy) return;
    const g=this.worldMouse(e);
    if (!this.map.inBounds(g.x,g.y)) return;
    const key = `${g.x},${g.y}`;
    if (this.reachable.has(key)) {
      const cost = this.sprintMode ? 2 : 1;
      const range = this.sprintMode ? this.moveRange()+2 : this.moveRange();
      this.moveEntity(this.player, g.x, g.y, range, () => {
        this.ap -= cost;
        if (this.sprintMode) this.emitNoise(g.x,g.y,4,'You sprint loudly.');
        this.sprintMode=false;
        this.afterPlayerAction();
      });
      this.playTone(180,0.03,'square');
      return;
    }
    this.player.selected = (g.x===this.player.x && g.y===this.player.y);
  }

  onKey(e){
    if (e.key === ' ') { e.preventDefault(); this.tryEndTurn(); }
    if (e.key === 'Escape') this.sprintMode = false;
    if (e.key.toLowerCase()==='h') this.hideAction();
    if (e.key.toLowerCase()==='e') this.interact();
    if (e.key.toLowerCase()==='t') { this.autoPlay=!this.autoPlay; this.pushLog(`Autoplay ${this.autoPlay?'ON':'OFF'}.`); }
    if (e.key==='Shift') this.sprintMode = !this.sprintMode;
    const pan=24/this.camera.zoom;
    if (e.key==='ArrowUp' || e.key.toLowerCase()==='w') this.camera.targetY += pan;
    if (e.key==='ArrowDown' || e.key.toLowerCase()==='s') this.camera.targetY -= pan;
    if (e.key==='ArrowLeft' || e.key.toLowerCase()==='a') this.camera.targetX += pan;
    if (e.key==='ArrowRight' || e.key.toLowerCase()==='d') this.camera.targetX -= pan;
  }

  setReachable(){
    this.reachable = new Set();
    if (this.turn !== 'player' || this.ap <= 0) return;
    const moveCost = this.sprintMode ? 2 : 1;
    if (this.ap < moveCost) return;
    const r = this.sprintMode ? this.moveRange()+2 : this.moveRange();
    const q=[[this.player.x,this.player.y,0]];
    const seen=new Set([`${this.player.x},${this.player.y}`]);
    while(q.length){
      const [x,y,d]=q.shift();
      if (d>0) this.reachable.add(`${x},${y}`);
      if (d===r) continue;
      for(const [nx,ny] of this.neighbors(x,y)){
        const k=`${nx},${ny}`; if(seen.has(k)) continue;
        if(!this.passable(nx,ny,true)) continue;
        seen.add(k); q.push([nx,ny,d+1]);
      }
    }
  }

  moveRange(){ return this.player.injured ? 2 : 3; }

  neighbors(x,y){ return [[x+1,y],[x-1,y],[x,y+1],[x,y-1]].filter(([a,b])=>this.map.inBounds(a,b)); }
  findClosestOpenTileTowardPlayer(){
    let best = null;
    for (let y=0; y<this.map.h; y++) {
      for (let x=0; x<this.map.w; x++) {
        if (!this.passable(x,y,false)) continue;
        const p = this.shortestPath(this.killer.x, this.killer.y, x, y, 99, true);
        if (!p.length && !(x===this.killer.x && y===this.killer.y)) continue;
        const d = Math.abs(x-this.player.x) + Math.abs(y-this.player.y);
        if (!best || d < best.d) best = {x,y,d};
      }
    }
    return best;
  }

  chooseKillerStep(){
    const chaseTargets = this.neighbors(this.player.x, this.player.y)
      .filter(([x, y]) => this.passable(x, y, false));

    let bestPath = null;
    for (const [tx, ty] of chaseTargets) {
      const path = this.shortestPath(this.killer.x, this.killer.y, tx, ty, 99, true);
      if (!path.length) continue;
      if (!bestPath || path.length < bestPath.length) bestPath = path;
    }

    if (bestPath && bestPath.length) {
      const [sx, sy] = bestPath[0];
      return { x: sx, y: sy };
    }

    const fallback = this.neighbors(this.killer.x, this.killer.y)
      .filter(([x, y]) => this.passable(x, y, false))
      .map(([x, y]) => ({ x, y, m: Math.abs(x-this.player.x)+Math.abs(y-this.player.y) }))
      .sort((a, b) => a.m - b.m)[0];

    return fallback || null;
  }
  passable(x,y,ignoreKiller=false){
    const t=this.map.get(x,y); if(!t || t.blocked) return false;
    if (!ignoreKiller && x===this.killer.x && y===this.killer.y) return false;
    return true;
  }

  shortestPath(sx,sy,tx,ty,max=99,ignorePlayer=true){
    const q=[[sx,sy]]; const prev=new Map(); const seen=new Set([`${sx},${sy}`]);
    while(q.length){
      const [x,y]=q.shift();
      if (x===tx && y===ty) break;
      for(const [nx,ny] of this.neighbors(x,y)){
        const key=`${nx},${ny}`; if(seen.has(key)) continue;
        if(!this.passable(nx,ny,false)) continue;
        if(!ignorePlayer && nx===this.player.x && ny===this.player.y) continue;
        seen.add(key); prev.set(key,[x,y]); q.push([nx,ny]);
      }
    }
    const out=[]; let cur=[tx,ty];
    if (!prev.has(`${tx},${ty}`) && !(sx===tx&&sy===ty)) return [];
    while(!(cur[0]===sx&&cur[1]===sy)) { out.push(cur); cur=prev.get(`${cur[0]},${cur[1]}`); if(!cur) return []; }
    out.reverse();
    return out.slice(0,max);
  }

  spawnExitKey(){
    if (this.keySpawned) return;
    const t = this.map.get(this.keySpawnPos.x, this.keySpawnPos.y);
    if (!t || t.blocked) return;
    this.keySpawned = true;
    t.interact = 'key';
    t.deco = 'key';
    this.emitNoise(this.keySpawnPos.x, this.keySpawnPos.y, 6, 'A key ring clatters across the block!');
    this.pushLog("It's locked. You need a key!");
  }

  moveEntity(ent, tx, ty, maxStep, done){
    const path=this.shortestPath(ent.x,ent.y,tx,ty,maxStep);
    if (!path.length && !(ent.x===tx&&ent.y===ty)) return;
    this.turnBusy=true;
    const seq = [...path];
    const step = () => {
      if (!seq.length) { this.turnBusy=false; done?.(); return; }
      const [nx,ny]=seq.shift();
      ent.anim = { from:{x:ent.x,y:ent.y}, to:{x:nx,y:ny}, t:0 };
      ent.x=nx; ent.y=ny;
      this.playTone(95,0.02,'triangle');
      setTimeout(step, 120);
    };
    step();
  }

  interact(){
    if (this.state!=='playing' || this.turn!=='player' || this.ap<1 || this.turnBusy) return;
    const t=this.map.get(this.player.x,this.player.y);
    if (t.exit) {
      this.ap-=1;
      if (!this.keySpawned) {
        this.spawnExitKey();
        this.afterPlayerAction();
        return;
      }
      if (!this.hasExitKey) {
        this.pushLog("It's locked. You need a key!");
        this.afterPlayerAction();
        return;
      }
      this.win();
      return;
    }
    if (t.interact==='key') {
      this.ap-=1;
      this.hasExitKey = true;
      t.interact = null;
      if (t.deco==='key') t.deco = null;
      this.pushLog('You grab the gate key. Get back to the exit!');
      this.playTone(520,0.07,'square');
      this.afterPlayerAction();
      return;
    }
    if (t.interact==='alarm' && !t.used) {
      t.used=true; this.ap-=1; this.emitNoise(this.player.x,this.player.y,7,'You trigger an alarm!'); this.playTone(440,0.1,'sawtooth');
      this.afterPlayerAction(); return;
    }
    if (t.interact==='vault' && t.vaultTo) {
      this.ap-=1;
      const to=t.vaultTo; this.player.x=to.x; this.player.y=to.y;
      this.emitNoise(to.x,to.y,5,'You vault a barrier.');
      this.afterPlayerAction();
      return;
    }
    this.pushLog('Nothing to interact with here.');
  }

  hideAction(){
    if (this.state!=='playing' || this.turn!=='player' || this.ap<1 || this.turnBusy) return;
    const t=this.map.get(this.player.x,this.player.y);
    if (!t.hide) return this.pushLog('No hiding spot here.');
    this.player.hidden = !this.player.hidden;
    this.ap -= 1;
    this.pushLog(this.player.hidden ? 'You hide in the shadows.' : 'You step out of hiding.');
    this.afterPlayerAction();
  }

  afterPlayerAction(){
    this.killer.lastSeen = { x: this.player.x, y: this.player.y };
    this.setReachable();
    this.updateHUD();
    if(this.ap<=0) this.tryEndTurn();
  }

  tryEndTurn(){
    if (this.state!=='playing' || this.turn!=='player' || this.turnBusy) return;
    this.turn='killer'; this.ap=0; this.updateHUD();
    this.pushLog('Killer turn...');
    setTimeout(()=>this.killerTurn(),250);
  }

  killerTurn(){
    if (this.state!=='playing') return;
    this.killer.state='CHASE';
    this.killer.ap = 3;
    const act = () => {
      if (this.killer.ap<=0 || this.state!=='playing') return this.endKillerTurn();

      if (this.isAdjacent(this.killer,this.player)) {
        this.killerAttack();
        this.killer.ap-=1;
        return setTimeout(act, 280);
      }

      // Relentless pressure: the killer always tracks your latest position.
      this.killer.lastSeen={x:this.player.x,y:this.player.y};
      if (!this.firstSighting && this.canDetectPlayer(true)) this.triggerSting();

      const step = this.chooseKillerStep();
      if (step) {
        this.killer.x=step.x;
        this.killer.y=step.y;
        this.killer.ap-=1;
        this.playTone(85,0.03,'triangle');
      } else {
        // Hard guarantee: if pathing fails, snap toward nearest reachable tile near player.
        const snap = this.findClosestOpenTileTowardPlayer();
        if (snap && (snap.x !== this.killer.x || snap.y !== this.killer.y)) {
          this.killer.x = snap.x;
          this.killer.y = snap.y;
          this.killer.ap -= 1;
          this.pushLog('The killer cuts through side streets to close in.');
          this.playTone(70,0.04,'square');
        } else {
          this.killer.ap=0;
        }
      }
      setTimeout(act,240);
    };
    act();
  }

  endKillerTurn(){
    this.turn='player';
    this.ap=2;
    this.setReachable();
    this.pushLog('Your turn.');
    this.updateHUD();
    if (this.autoPlay) this.autoStep();
  }

  canDetectPlayer(strict=false){
    const dist=Math.abs(this.killer.x-this.player.x)+Math.abs(this.killer.y-this.player.y);
    if (this.player.hidden && dist>1) return false;
    const sight = strict ? 9 : 8;
    if (dist>sight) return false;
    return this.hasLOS(this.killer.x,this.killer.y,this.player.x,this.player.y);
  }

  hasLOS(x0,y0,x1,y1){
    let dx=Math.abs(x1-x0), sx=x0<x1?1:-1;
    let dy=-Math.abs(y1-y0), sy=y0<y1?1:-1;
    let err=dx+dy;
    while(true){
      if (!(x0===x1&&y0===y1)) {
        const t=this.map.get(x0,y0);
        if (t && (t.type==='house' || t.type==='hedge')) return false;
      }
      if (x0===x1 && y0===y1) break;
      const e2=2*err;
      if (e2>=dy){ err+=dy; x0+=sx; }
      if (e2<=dx){ err+=dx; y0+=sy; }
    }
    return true;
  }

  findNearbyHide(x,y,r){
    const out=[];
    for(let yy=Math.max(0,y-r);yy<=Math.min(this.map.h-1,y+r);yy++)
      for(let xx=Math.max(0,x-r);xx<=Math.min(this.map.w-1,x+r);xx++)
        if(this.map.get(xx,yy).hide) out.push({x:xx,y:yy,d:Math.abs(xx-x)+Math.abs(yy-y)});
    out.sort((a,b)=>a.d-b.d);
    return out;
  }

  findPanicEscapeTile(){
    const options = this.neighbors(this.player.x, this.player.y)
      .filter(([x,y]) => this.passable(x,y,false))
      .map(([x,y]) => ({x, y, d: Math.abs(x-this.killer.x)+Math.abs(y-this.killer.y)}))
      .filter(pos => pos.d >= 2)
      .sort((a,b) => b.d - a.d);
    return options[0] || null;
  }

  isAdjacent(a,b){ return Math.abs(a.x-b.x)+Math.abs(a.y-b.y)===1; }

  killerAttack(){
    const roll = 1 + Math.floor(Math.random() * 6);
    const escapeTile = this.findPanicEscapeTile();
    if (roll >= 5 && escapeTile) {
      this.player.x = escapeTile.x;
      this.player.y = escapeTile.y;
      this.player.hidden = false;
      this.shake = 6;
      this.pushLog(`Panic Roll ${roll}: You slip away from the blade!`);
      this.showCombatBanner(`PANIC ROLL ${roll} — ESCAPE!`, true);
      this.playTone(280,0.08,'triangle');
      return;
    }

    this.shake = 12;
    this.hp -= 1;
    this.player.hidden = false;
    this.pushLog(`Panic Roll ${roll}: The knife finds you.`);
    this.showCombatBanner(`PANIC ROLL ${roll} — HIT!`, true);
    if (this.hp===1 && !this.player.injured) { this.player.injured=true; this.pushLog('Injured! Movement reduced.'); }
    this.playTone(55,0.13,'sawtooth');
    if (this.hp<=0) this.lose();
  }

  emitNoise(x,y,str,msg){
    this.noisePings.push({x,y,r:str,t:1});
    this.killer.heard={x,y};
    this.killer.state='INVESTIGATE';
    this.pushLog(msg || 'Noise echoes in the dark.');
  }

  autoStep(){
    if (this.turn!=='player' || this.state!=='playing' || this.turnBusy) return;
    const here=this.map.get(this.player.x,this.player.y);
    if ((here.exit || here.interact==='key') && this.ap>0) return this.interact();
    if (this.ap===2 && this.map.get(this.player.x,this.player.y).hide && !this.player.hidden && Math.random()<0.15) return this.hideAction();
    const target = (this.keySpawned && !this.hasExitKey) ? this.keySpawnPos : this.exitPos;
    const p=this.shortestPath(this.player.x,this.player.y,target.x,target.y,99,true);
    if (p.length) {
      const step=p[Math.min(p.length-1, this.moveRange()-1)];
      this.moveEntity(this.player,step[0],step[1],this.moveRange(),()=>{ this.ap-=1; this.afterPlayerAction(); if(this.ap>0) setTimeout(()=>this.autoStep(),120);});
    } else this.tryEndTurn();
  }

  centerOn(x,y,instant=false){
    const p=this.gridToScreen(x,y,this.map.get(x,y)?.height||0);
    this.camera.targetX = canvas.width/2 - p.x*this.camera.zoom;
    this.camera.targetY = canvas.height/2 - p.y*this.camera.zoom;
    if (instant) { this.camera.x=this.camera.targetX; this.camera.y=this.camera.targetY; }
  }

  showCombatBanner(text, strong=false){
    this.combatBanner.text = text;
    this.combatBanner.t = 1;
    this.combatBanner.strong = strong;
  }

  drawCombatBanner(){
    if (!this.combatBanner || this.combatBanner.t <= 0) return;
    const alpha = Math.max(0, this.combatBanner.t);
    const pulse = this.combatBanner.strong ? (0.8 + 0.2*Math.sin(performance.now()/80)) : 1;
    const w = Math.min(canvas.width - 60, 660);
    const h = 78;
    const x = (canvas.width - w)/2;
    const y = canvas.height*0.46 - h/2;

    ctx.save();
    ctx.globalAlpha = 0.9 * alpha;
    ctx.fillStyle = 'rgba(55, 8, 12, 0.94)';
    ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = 'rgba(255,85,85,0.95)';
    ctx.lineWidth = 2;
    ctx.strokeRect(x, y, w, h);

    ctx.globalAlpha = alpha;
    ctx.fillStyle = this.combatBanner.strong ? `rgba(255,110,110,${pulse})` : 'rgba(255,170,170,0.95)';
    ctx.shadowColor = 'rgba(255,0,0,0.45)';
    ctx.shadowBlur = 20;
    ctx.font = '800 42px Inter, Segoe UI, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(this.combatBanner.text, canvas.width/2, y + h/2);
    ctx.restore();

    this.combatBanner.t -= this.combatBanner.strong ? 0.009 : 0.014;
  }

  pushLog(text){
    this.log.unshift(text);
    this.log=this.log.slice(0,8);
    const ul=document.getElementById('logList');
    ul.innerHTML=this.log.map(v=>`<li>${v}</li>`).join('');
  }

  updateHUD(){
    document.getElementById('turnInfo').textContent=`Turn: ${this.turn[0].toUpperCase()+this.turn.slice(1)}`;
    document.getElementById('apInfo').textContent=`AP: ${this.ap}/${this.maxAp}`;
    document.getElementById('hpInfo').textContent=`Health: ${'❤'.repeat(this.hp)}${'♡'.repeat(Math.max(0,2-this.hp))}`;
    document.getElementById('objective').textContent = 'Objective: Escape through the gate (E).';
  }

  showStart(){ this.showOnly('startScreen'); }
  hideOverlay(){ document.getElementById('overlay').classList.remove('show'); }
  showOnly(id){
    document.getElementById('overlay').classList.add('show');
    ['startScreen','helpScreen','winScreen','loseScreen','stingScreen'].forEach(k=>document.getElementById(k).classList.add('hidden'));
    document.getElementById(id).classList.remove('hidden');
  }

  triggerSting(){
    this.firstSighting = true;
    this.showOnly('stingScreen');
    this.playTone(240,0.08,'sawtooth');
    setTimeout(()=>{ if(this.state==='playing') this.hideOverlay(); }, 700);
  }

  restart(){ this.reset(); this.showOnly('startScreen'); }
  win(){
    if (!this.hasExitKey) {
      if (!this.keySpawned) this.spawnExitKey();
      this.pushLog("It's locked. You need a key!");
      return;
    }
    this.state='win';
    this.showOnly('winScreen');
    this.pushLog('You escaped alive.');
  }
  lose(){ this.state='lose'; this.showOnly('loseScreen'); this.pushLog('You were caught.'); }

  playTone(freq=220,dur=0.06,type='sine'){
    if (this.sound.muted) return;
    if (!this.sound.ctx) this.sound.ctx = new (window.AudioContext || window.webkitAudioContext)();
    const a=this.sound.ctx;
    const o=a.createOscillator(); const g=a.createGain();
    o.type=type; o.frequency.value=freq;
    g.gain.value=0.0001;
    o.connect(g); g.connect(a.destination);
    const t=a.currentTime;
    g.gain.exponentialRampToValueAtTime(0.05,t+0.01);
    g.gain.exponentialRampToValueAtTime(0.0001,t+dur);
    o.start(t); o.stop(t+dur+0.01);
  }

  drawBackdrop(){
    const g = ctx.createLinearGradient(0, 0, 0, canvas.height);
    g.addColorStop(0, '#10182b');
    g.addColorStop(0.55, '#0b1120');
    g.addColorStop(1, '#070a12');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // Distant fog band + vignette for mood.
    const fog = ctx.createLinearGradient(0, canvas.height*0.35, 0, canvas.height*0.9);
    fog.addColorStop(0, 'rgba(80,110,170,0.08)');
    fog.addColorStop(1, 'rgba(12,18,32,0.02)');
    ctx.fillStyle = fog;
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    const vignette = ctx.createRadialGradient(canvas.width*0.5, canvas.height*0.45, canvas.height*0.15, canvas.width*0.5, canvas.height*0.5, canvas.height*0.9);
    vignette.addColorStop(0, 'rgba(0,0,0,0)');
    vignette.addColorStop(1, 'rgba(0,0,0,0.42)');
    ctx.fillStyle = vignette;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }

  drawTile(x,y,tile){
    const p=this.gridToScreen(x,y,tile.height);
    const tx=p.x, ty=p.y;
    const cols={street:'#2a3344',house:'#5b3f4a',fence:'#4d5a6b',hedge:'#2f5c43'};
    const c=cols[tile.type]||'#2a3344';
    const shade=tile.height?16:0;

    ctx.beginPath();
    ctx.moveTo(tx, ty-this.tileH/2);
    ctx.lineTo(tx+this.tileW/2, ty);
    ctx.lineTo(tx, ty+this.tileH/2);
    ctx.lineTo(tx-this.tileW/2, ty);
    ctx.closePath();
    ctx.fillStyle = this.tint(c,shade);
    ctx.fill();
    ctx.strokeStyle='#1a2538';
    ctx.stroke();

    // Side depth for elevated tiles.
    if (tile.height) {
      ctx.fillStyle = 'rgba(0,0,0,0.22)';
      ctx.beginPath();
      ctx.moveTo(tx, ty+this.tileH/2);
      ctx.lineTo(tx+this.tileW/2, ty);
      ctx.lineTo(tx+this.tileW/2, ty+14);
      ctx.lineTo(tx, ty+this.tileH/2+14);
      ctx.closePath();
      ctx.fill();
    }

    // Subtle asphalt texture lines.
    if (tile.type==='street') {
      ctx.strokeStyle='rgba(255,255,255,0.04)';
      ctx.beginPath();
      ctx.moveTo(tx-16,ty-2);
      ctx.lineTo(tx+12,ty+6);
      ctx.stroke();
    }

    const key=`${x},${y}`;
    if (this.reachable.has(key)) this.drawOverlayDiamond(tx,ty,'rgba(95,155,255,0.35)');
    if (tile.interact || tile.exit) this.drawOverlayDiamond(tx,ty,'rgba(255,219,115,0.22)');
    const threat = Math.abs(this.killer.x-x)+Math.abs(this.killer.y-y)<=2;
    if (threat) this.drawOverlayDiamond(tx,ty,'rgba(255,90,90,0.18)');

    if (tile.hide) {
      ctx.fillStyle='#2b7a5e';
      ctx.fillRect(tx-10,ty-20,20,14);
      ctx.fillStyle='rgba(145,230,178,0.18)';
      ctx.fillRect(tx-8,ty-22,16,4);
    }

    if (tile.deco==='lamp') {
      ctx.strokeStyle='#f9d98a';
      ctx.beginPath();
      ctx.moveTo(tx,ty-18);
      ctx.lineTo(tx,ty-36);
      ctx.stroke();
      const glow=ctx.createRadialGradient(tx,ty-36,2,tx,ty-36,26);
      glow.addColorStop(0,'rgba(255,235,160,0.45)');
      glow.addColorStop(1,'rgba(255,235,160,0.02)');
      ctx.fillStyle=glow;
      ctx.beginPath();
      ctx.arc(tx,ty-36,26,0,Math.PI*2);
      ctx.fill();
    }

    if (tile.deco==='gate') {
      ctx.fillStyle='#aab6ca';
      ctx.fillRect(tx-14,ty-24,28,18);
      ctx.fillStyle='rgba(20,28,42,0.5)';
      for (let i=-10;i<=10;i+=5) ctx.fillRect(tx+i,ty-24,2,18);
    }

    if (tile.deco==='key') {
      ctx.fillStyle='#ffd966';
      ctx.beginPath();
      ctx.arc(tx,ty-22,5,0,Math.PI*2);
      ctx.fill();
      ctx.fillRect(tx+2,ty-23,10,3);
      ctx.fillRect(tx+9,ty-26,2,2);
      ctx.fillRect(tx+12,ty-26,2,2);
    }

    if (tile.lowWall) {
      ctx.fillStyle='#7f8798';
      ctx.fillRect(tx-18,ty-8,36,6);
      ctx.fillStyle='rgba(255,255,255,0.18)';
      ctx.fillRect(tx-18,ty-8,36,1);
    }
  }

  drawOverlayDiamond(x,y,color){
    ctx.fillStyle=color;
    ctx.beginPath();
    ctx.moveTo(x,y-this.tileH/2+2);
    ctx.lineTo(x+this.tileW/2-2,y);
    ctx.lineTo(x,y+this.tileH/2-2);
    ctx.lineTo(x-this.tileW/2+2,y);
    ctx.closePath();
    ctx.fill();
  }

  tint(hex,amount){
    const n=parseInt(hex.slice(1),16);
    const r=Math.min(255,((n>>16)&255)+amount);
    const g=Math.min(255,((n>>8)&255)+amount);
    const b=Math.min(255,(n&255)+amount);
    return `rgb(${r},${g},${b})`;
  }

  drawEntity(ent,isPlayer){
    const t=this.map.get(ent.x,ent.y);
    const p=this.gridToScreen(ent.x,ent.y,t.height);

    // Drop shadow
    ctx.fillStyle='rgba(0,0,0,0.32)';
    ctx.beginPath();
    ctx.ellipse(p.x,p.y-8,12,6,0,0,Math.PI*2);
    ctx.fill();

    if (isPlayer) {
      ctx.fillStyle=this.player.hidden?'#3a4d64':'#88d6ff';
      ctx.fillRect(p.x-8,p.y-34,16,22);
      ctx.fillStyle='#3d86bd';
      ctx.fillRect(p.x-8,p.y-24,16,4);
      ctx.fillStyle='#dbe8ff';
      ctx.fillRect(p.x-5,p.y-42,10,9);
      ctx.fillStyle='#1f2e44';
      ctx.fillRect(p.x-3,p.y-39,2,2);
      ctx.fillRect(p.x+1,p.y-39,2,2);
    } else {
      // Killer: coat + mask + knife silhouette
      ctx.fillStyle='#1a1d24';
      ctx.fillRect(p.x-11,p.y-40,22,30);
      ctx.fillStyle='#11141a';
      ctx.fillRect(p.x-14,p.y-17,28,8);
      ctx.fillStyle='#f1f1f1';
      ctx.beginPath();
      ctx.ellipse(p.x,p.y-44,8,10,0,0,Math.PI*2);
      ctx.fill();
      ctx.strokeStyle='#cc4444';
      ctx.beginPath();
      ctx.moveTo(p.x-4,p.y-46);
      ctx.lineTo(p.x+4,p.y-42);
      ctx.stroke();
      ctx.fillStyle='#b8bdc8';
      ctx.fillRect(p.x+8,p.y-30,15,3);
      ctx.fillStyle='#9098a6';
      ctx.fillRect(p.x+21,p.y-31,3,5);
    }
  }

  drawHover(){
    if (!this.hover || !this.map.inBounds(this.hover.x,this.hover.y)) return;
    const tile=this.map.get(this.hover.x,this.hover.y);
    const p=this.gridToScreen(this.hover.x,this.hover.y,tile.height);
    const pulse=(Math.sin(performance.now()/180)+1)/2;
    this.drawOverlayDiamond(p.x,p.y,`rgba(255,255,255,${0.08+0.09*pulse})`);
    let txt = tile.blocked ? 'Blocked' : tile.hide ? 'Hide Spot' : tile.interact ? `Interact: ${tile.interact}` : 'Ground';
    ctx.fillStyle='rgba(8,10,18,0.88)'; ctx.fillRect(p.x+18,p.y-40,120,22);
    ctx.fillStyle='#e8eef9'; ctx.font='12px sans-serif'; ctx.fillText(txt,p.x+24,p.y-25);
  }

  drawNoise(){
    this.noisePings.forEach(n=>{ n.t-=0.02; const p=this.gridToScreen(n.x,n.y,this.map.get(n.x,n.y).height);
      ctx.strokeStyle=`rgba(255,214,120,${n.t})`; ctx.beginPath(); ctx.arc(p.x,p.y, (1-n.t)*n.r*10, 0, Math.PI*2); ctx.stroke();
    });
    this.noisePings=this.noisePings.filter(n=>n.t>0);
  }

  loop(){
    this.drawBackdrop();
    this.camera.x += (this.camera.targetX-this.camera.x)*0.14;
    this.camera.y += (this.camera.targetY-this.camera.y)*0.14;
    if (this.shake>0) this.shake*=0.82;
    const sx=(Math.random()-0.5)*this.shake, sy=(Math.random()-0.5)*this.shake;

    ctx.save();
    ctx.translate(this.camera.x+sx,this.camera.y+sy);
    ctx.scale(this.camera.zoom,this.camera.zoom);

    for(let y=0;y<this.map.h;y++) for(let x=0;x<this.map.w;x++) this.drawTile(x,y,this.map.get(x,y));
    this.drawNoise();
    this.drawEntity(this.killer,false);
    this.drawEntity(this.player,true);
    if (this.isAdjacent(this.killer,this.player) && this.turn==='killer') {
      const a=this.gridToScreen(this.killer.x,this.killer.y,this.map.get(this.killer.x,this.killer.y).height);
      const b=this.gridToScreen(this.player.x,this.player.y,this.map.get(this.player.x,this.player.y).height);
      ctx.strokeStyle='rgba(255,80,80,0.8)'; ctx.lineWidth=3; ctx.beginPath(); ctx.moveTo(a.x,a.y-30); ctx.lineTo(b.x,b.y-30); ctx.stroke(); ctx.lineWidth=1;
    }
    this.drawHover();

    ctx.restore();

    this.drawCombatBanner();

    if (this.autoPlay && this.turn==='player' && !this.turnBusy && this.state==='playing') this.autoStep();
    requestAnimationFrame(()=>this.loop());
  }
}

const game = new Game();
window.__game = game;
