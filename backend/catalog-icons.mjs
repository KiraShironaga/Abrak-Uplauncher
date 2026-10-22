import fs from'node:fs';
const data=JSON.parse(fs.readFileSync(new URL('../catalog/altere-icons.json',import.meta.url),'utf8'));
export const altereMonsterIds=data.monster_ids;
export const altereIconIndex=id=>{const index=altereMonsterIds.indexOf(Number(id));return index<0?null:index+1;};
