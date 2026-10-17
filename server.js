const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const PUBLIC = path.join(__dirname, 'public');
const rooms = new Map();

function roomCode(){
  const chars='ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let x;
  do{x=Array.from({length:5},()=>chars[Math.floor(Math.random()*chars.length)]).join('')}while(rooms.has(x));
  return x;
}
function cleanName(n){return String(n||'').trim().replace(/\s+/g,' ').slice(0,24)||'Игрок'}
function send(ws,p){if(ws.readyState===1)ws.send(JSON.stringify(p))}
function broadcast(r,p){for(const x of r.players.values())send(x.ws,p)}
function playerList(r){return [...r.players.values()].map(p=>({id:p.id,name:p.name,isHost:p.id===r.hostId}))}
function clampBotCount(r,n){const humans=r.players.size;const min=Math.max(0,4-humans);const max=Math.max(0,8-humans);return Math.max(min,Math.min(max,Number.isFinite(Number(n))?Number(n):min))}
function roundOptions(total){if(total===4)return ['8','16','end'];if(total===5)return ['10','20','end'];if(total===6)return ['12','end'];if(total===7)return ['14','end'];return ['end']}
function normalizeRoomSettings(r){r.botCount=clampBotCount(r,r.botCount);const total=r.players.size+r.botCount;const opts=roundOptions(Math.max(4,Math.min(8,total)));if(!opts.includes(String(r.roundMode)))r.roundMode=opts[0]}
function lobbyState(r){normalizeRoomSettings(r);return {type:'lobby',roomCode:r.code,hostId:r.hostId,started:r.started,botCount:r.botCount,roundMode:r.roundMode,players:playerList(r)}}

function leave(p){
  if(!p.roomCode)return;
  const r=rooms.get(p.roomCode);
  if(!r){p.roomCode=null;return;}
  r.players.delete(p.id);
  const wasHost=r.hostId===p.id;
  if(wasHost){
    if(r.started){
      r.started=false;
      r.gameState=null;
      r.hostId=null;
      broadcast(r,{type:'gameReset',reason:'Создатель комнаты отключился.'});
    }else{
      const n=r.players.values().next().value;
      r.hostId=n?n.id:null;
    }
  }
  if(!r.players.size)rooms.delete(r.code);
  else broadcast(r,lobbyState(r));
  p.roomCode=null;
}

const server=http.createServer((req,res)=>{
  let u=decodeURIComponent(req.url.split('?')[0]);
  if(u==='/')u='/index.html';
  const f=path.normalize(path.join(PUBLIC,u));
  if(!f.startsWith(PUBLIC)){res.writeHead(403);return res.end('Forbidden')}
  fs.readFile(f,(e,d)=>{
    if(e){res.writeHead(404);return res.end('Not found')}
    const t={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8'}[path.extname(f)]||'application/octet-stream';
    res.writeHead(200,{'Content-Type':t,'Cache-Control':'no-cache'});res.end(d);
  });
});

const wss=new WebSocketServer({server});
wss.on('connection',ws=>{
  const p={id:Math.random().toString(36).slice(2,10),name:'Игрок',roomCode:null,ws};
  send(ws,{type:'connected',playerId:p.id});

  ws.on('message',raw=>{
    let m;try{m=JSON.parse(raw)}catch{return send(ws,{type:'error',message:'Некорректный запрос.'})}

    if(m.type==='createRoom'){
      leave(p);
      const code=roomCode();
      const r={code,hostId:p.id,players:new Map(),started:false,botCount:3,roundMode:'8',gameState:null};
      rooms.set(code,r);
      p.name=cleanName(m.name);p.roomCode=code;r.players.set(p.id,p);
      return broadcast(r,lobbyState(r));
    }

    if(m.type==='joinRoom'){
      leave(p);
      const code=String(m.roomCode||'').trim().toUpperCase();
      const r=rooms.get(code);
      if(!r)return send(ws,{type:'error',message:'Комната не найдена.'});
      if(r.started)return send(ws,{type:'error',message:'Игра уже началась. Подключиться к ней сейчас нельзя.'});
      if(r.players.size>=8)return send(ws,{type:'error',message:'Комната заполнена.'});
      p.name=cleanName(m.name);p.roomCode=code;r.players.set(p.id,p);
      return broadcast(r,lobbyState(r));
    }

    if(m.type==='leaveRoom'){
      leave(p);return send(ws,{type:'leftRoom'});
    }

    const r=p.roomCode?rooms.get(p.roomCode):null;
    if(!r)return;

    if(m.type==='setSettings'){
      if(r.hostId!==p.id)return send(ws,{type:'error',message:'Только создатель комнаты может менять настройки.'});
      if(r.started)return;
      r.botCount=clampBotCount(r,m.botCount);
      r.roundMode=String(m.roundMode||'end');
      normalizeRoomSettings(r);
      return broadcast(r,lobbyState(r));
    }

    if(m.type==='startGame'){
      if(r.hostId!==p.id)return send(ws,{type:'error',message:'Только создатель комнаты может начать игру.'});
      if(r.started)return;
      normalizeRoomSettings(r);
      if(r.players.size+r.botCount<4 || r.players.size+r.botCount>8)return send(ws,{type:'error',message:'Для начала игры нужно от 4 до 8 игроков всего.'});
      if(!roundOptions(r.players.size+r.botCount).includes(String(r.roundMode)))return send(ws,{type:'error',message:'Недопустимое количество раундов для этого состава.'});
      r.started=true;
      r.gameState=null;
      return broadcast(r,{type:'gameStarting',players:playerList(r),botCount:r.botCount,roundMode:r.roundMode});
    }

    if(m.type==='gameAction'){
      if(!r.started)return;
      // Только авторитетный хост исполняет действия. Сервер лишь доставляет
      // действия от остальных игроков хосту, чтобы состояние было единым.
      if(p.id===r.hostId)return;
      return send([...r.players.values()].find(x=>x.id===r.hostId)?.ws,{type:'gameAction',fromId:p.id,action:m.action,payload:m.payload||{}});
    }

    if(m.type==='gameState'){
      if(!r.started || r.hostId!==p.id)return;
      r.gameState=m.state||null;
      return broadcast(r,{type:'gameState',state:r.gameState});
    }

    if(m.type==='resetGame'){
      if(r.hostId!==p.id)return send(ws,{type:'error',message:'Только создатель комнаты может вернуть игру в лобби.'});
      r.started=false;r.gameState=null;
      return broadcast(r,{type:'gameReset'});
    }
  });

  ws.on('close',()=>leave(p));
});

server.listen(PORT,()=>console.log('Football Imaginarium server on '+PORT));
