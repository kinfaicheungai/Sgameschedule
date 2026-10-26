self.addEventListener('install',()=>self.skipWaiting());
self.addEventListener('activate',event=>event.waitUntil(self.clients.claim()));
self.addEventListener('push',event=>{
 let data={title:'SSA Match Alerts',body:'Upcoming match',url:'/'};
 try{data={...data,...event.data.json()}}catch{}
 event.waitUntil(self.registration.showNotification(data.title,{body:data.body,icon:'/icon-192.png',badge:'/icon-192.png',tag:'ssa-'+Date.now(),data:{url:data.url}}));
});
self.addEventListener('notificationclick',event=>{event.notification.close();event.waitUntil(self.clients.matchAll({type:'window',includeUncontrolled:true}).then(async clients=>{const url=new URL(event.notification.data?.url||'/',self.location.origin).href;for(const c of clients){if(c.url===url&&'focus'in c)return c.focus()}return self.clients.openWindow(url)}))});
