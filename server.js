const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const PUBLIC = path.join(__dirname, 'public');
const rooms = new Map();

function roomCode(){
  const c='ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let x;
  do{x=Array.from({length:5},()=>c[Math.floor(Math.random()*c.length)]).join('')}while(rooms.has(x));
  return x;
}
function cleanName(n){return String(n||'').trim().replace(/\s+/g,' ').slice(0,24)||'Игрок'}
function send(ws,p){if(ws.readyState===1)ws.send(JSON.stringify(p))}
function broadcast(r,p){for(const x of r.players.values())send(x.ws,p)}
function state(r){
  return {
    type:'lobby',
    roomCode:r.code,
    hostId:r.hostId,
    settings:r.settings,
    players:[...r.players.values()].map(p=>({id:p.id,name:p.name,isHost:p.id===r.hostId}))
  };
}
function leave(p){
  if(!p.roomCode)return;
  const r=rooms.get(p.roomCode);
  if(!r)return;
  r.players.delete(p.id);
  if(r.hostId===p.id){
    const n=r.players.values().next().value;
    r.hostId=n?n.id:null;
  }
  if(!r.players.size)rooms.delete(r.code);
  else broadcast(r,state(r));
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
    res.writeHead(200,{'Content-Type':t});
    res.end(d);
  });
});

const wss=new WebSocketServer({server});
wss.on('connection',ws=>{
  const p={id:Math.random().toString(36).slice(2,10),name:'Игрок',roomCode:null,ws};
  send(ws,{type:'connected',playerId:p.id});

  ws.on('message',raw=>{
    let m;
    try{m=JSON.parse(raw)}catch{return send(ws,{type:'error',message:'Некорректный запрос.'})}

    if(m.type==='createRoom'){
      leave(p);
      const code=roomCode();
      const r={
        code,
        hostId:p.id,
        players:new Map,
        settings:{botCount:3,roundMode:'8',botNames:[]}
      };
      rooms.set(code,r);
      p.name=cleanName(m.name);
      p.roomCode=code;
      r.players.set(p.id,p);
      return send(ws,state(r));
    }

    if(m.type==='joinRoom'){
      leave(p);
      const code=String(m.roomCode||'').trim().toUpperCase();
      const r=rooms.get(code);
      if(!r)return send(ws,{type:'error',message:'Комната не найдена.'});
      if(r.players.size>=8)return send(ws,{type:'error',message:'Комната заполнена.'});
      if(r.started)return send(ws,{type:'error',message:'Игра уже началась.'});
      p.name=cleanName(m.name);
      p.roomCode=code;
      r.players.set(p.id,p);
      return broadcast(r,state(r));
    }

    if(m.type==='setSettings'){
      const r=rooms.get(p.roomCode);
      if(!r)return;
      if(r.hostId!==p.id)return send(ws,{type:'error',message:'Только создатель комнаты может менять настройки.'});
      const botCount=Math.max(3,Math.min(7,Number(m.botCount)||3));
      const roundMode=String(m.roundMode||'8');
      const botNames=Array.isArray(m.botNames)?m.botNames.slice(0,botCount).map(cleanName):[];
      r.settings={botCount,roundMode,botNames};
      return broadcast(r,state(r));
    }

    if(m.type==='startGame'){
      const r=rooms.get(p.roomCode);
      if(!r)return;
      if(r.hostId!==p.id)return send(ws,{type:'error',message:'Только создатель комнаты может начать игру.'});
      if(r.players.size<1)return send(ws,{type:'error',message:'В комнате нет игроков.'});
      r.started=true;
      return broadcast(r,{
        type:'gameStarting',
        players:[...r.players.values()].map(x=>({id:x.id,name:x.name})),
        settings:r.settings
      });
    }

    if(m.type==='leaveRoom'){
      leave(p);
      return send(ws,{type:'leftRoom'});
    }
  });

  ws.on('close',()=>leave(p));
});

server.listen(PORT,()=>console.log('Football Imaginarium server on '+PORT));
