// Only our authenticated, same-origin image shelf is embedded. Other URLs
// stay ordinary links, so a message cannot load remote tracking images.
export function privateImageUrl(text:string,origin:string):boolean {
 try{const u=new URL(text);return u.origin===origin&&!u.search&&!u.hash&&/^\/api\/v1\/coffee-images\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(png|jpg|webp)$/.test(u.pathname)}catch{return false}
}
