// Briefly await only read-only inspection results, avoiding repeated browser round trips.
export async function waitForInspection(queued, read, {now=Date.now,wait=ms=>new Promise(resolve=>setTimeout(resolve,ms)),budgetMs=6000}={}) {
  if(!['inspect','count'].includes(queued.action))return queued;
  const deadline=now()+budgetMs;
  let result=queued;
  while(now()<deadline&&['queued','running'].includes(result.status)){
    await wait(250);
    if(now()>=deadline)break;
    let timer;
    try{
      const next=await Promise.race([read(queued.id),new Promise(resolve=>{timer=setTimeout(()=>resolve(null),Math.max(0,deadline-now()));})]);
      if(!next)break;
      result=next;
    }catch{return result;}
    finally{clearTimeout(timer);}
  }
  return result;
}
