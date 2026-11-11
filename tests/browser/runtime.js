window.chrome={runtime:{id:'local-preview',onMessage:{addListener(){}},getURL:p=>new URL('/'+p,location.href).href,sendMessage:async()=>({ok:false,error:{message:'这是本地界面测试，请使用安装后的扩展。'}})}};
