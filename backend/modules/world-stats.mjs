import{admin,fail,integer,MODE}from'./world-common.mjs';

// Model names come from module 6249 in the recovered chunk-common.js.
// Menu/table aliases and the model.type sent by the chart are both accepted.
const definitions=[
 ['players_new_fight','player_new_fight',['fight']],
 ['players_kama_generated','player_kama_generated',['fight','npc-sales']],
 ['players_monsters_kills','player_monster_kill',['fight']],
 ['players_drops_generated','player_drop_generated',['drop']],
 ['accounts_bigstore_sell','account_bigstore_sell',['hdv']],
 ['new_first_connection','new_first_connection',['first-connection']],
 ['monsters_win_fight','monsters_win_fight',['fight']],
 ['monsters_loose_fight','monsters_loose_fight',['fight']],
 ['accounts_opening_heroes_tutorial','account_opening_heroes_tutorial',['heroes-tutorial']],
 ['accounts_session_duration','account_session_duration',['session']],
 ['challenges_win','challenge_win',['challenge']],
 ['challenges_loose','challenge_loose',['challenge']],
 ['houses_sells','house_sell',['house-sale']],
 ['jobs_make_exotics','job_make_exotic',['exo']],
 ['players_collectors_attack','player_collector_attack',['collector-attack']],
 ['players_collectors_results','player_collector_result',['collector-result']],
 ['jobs_make_crafts','job_make_craft',['craft']],
 ['fights_results','fight_result',['fight']],
 ['fights_spells_triggered','fight_spell_triggered',['spell']],
 ['world_connections','world_connections',['connection']],
 ['world_disconnections','world_disconnections',['disconnection']],
 ['world_cron_connected','world_cron_connected',['connection-count']],
 ['world_channels_messages','world_channel_message',['chat']],
 ['jobs_breaking_objects','job_breaking_object',['break']],
 ['jobs_magic_fragments_opening','job_magic_fragment_opening',['magic-fragment']],
 ['players_objects_move_to_equip','player_object_move_to_equip',['equipment']],
 ['players_merchant_sell','player_merchant_sell',['merchant']],
 ['world_maps_session','world_map_session',['session','map-session']],
 ['world_kama_generated','world_kama_generated',['npc-sales','hdv']]
];
export const adminStatModels=definitions.map(([,type])=>type);
const models=new Map(definitions.flatMap(d=>[[d[0],d],[d[1],d]]));
function timestamp(c,value,label,end=false){if(value==null||value==='')return null;const v=String(value).replaceAll('/','-'),time=Date.parse(v);if(!Number.isFinite(time))fail(c,422,`${label} invalide.`);return time+(end&&/^\d{4}-\d{2}-\d{2}$/.test(v)?86400000-1:0);}
export function adminStats(c){
 admin(c,2);const model=models.get(c.params.type);if(!model)fail(c,404,'Type de statistique administrateur inconnu.');
 const server=integer(c,c.params.server,'Serveur'),[,type,kinds]=model;
 const from=timestamp(c,c.body?.date?.from,'Date de début'),to=timestamp(c,c.body?.date?.to,'Date de fin',true);
 if(from!==null&&to!==null&&from>to)fail(c,422,'La date de fin précède la date de début.');
 const events=c.state.list('worldEvents').filter(e=>Number(e.server_id)===server&&kinds.includes(e.type)&&(from===null||Date.parse(e.created_at)>=from)&&(to===null||Date.parse(e.created_at)<=to));
 return events.filter(e=>{
  if(type==='monsters_win_fight'||type==='challenge_loose')return e.won===false;
  if(type==='monsters_loose_fight'||type==='challenge_win'||type==='player_monster_kill')return e.won!==false;
  return true;
 }).map(e=>{
  const p=c.state.get('players',e.player_id),account=p?.account_id??e.account_id??null,n=Number(e.quantity??1),value=Number(e.value??n);
  return{
   ...e,id:e.id,player_id:e.player_id??null,account_id:account,user_id:e.user_id??p?.user_id,
   monster_id:e.monster_id??null,monster_template_id:e.monster_id??null,item_template_id:e.item_id??null,
   map_id:e.map_id??10300,fight_map_id:e.map_id??10300,next_map_id:e.next_map_id??10300,
   quantity:n,value,kamas:value,kama_value:value,price:value,
   type:type==='player_kama_generated'?(e.type==='fight'?'fight':'npc'):type==='world_kama_generated'?(e.type==='hdv'?'bigstore_sell':'npc'):e.type,
   date:e.created_at,success:e.won===false?0:1,level:p?.level??p?.lvl??1,
   message:e.type==='chat'?e.message:`Événement synthétique ${e.type} — ${MODE}`,channel:e.channel??null,
   duration:e.type==='session'?n:Number(e.duration??120),session_duration:e.type==='session'?n:Number(e.duration??0),
   fight_duration:Number(e.duration??120),fight_type:e.fight_type??0,fighters_length:e.fighters_length??1,
   chief_attackers_id:e.player_id??null,chief_defenders_id:e.target_id??null,
   attackers_length:e.attackers_length??1,defenders_length:e.defenders_length??1,winner_team:e.won===false?1:0,
   seller_account_id:account,customer_account_id:e.customer_account_id??null,
   seller_player_id:e.player_id??null,customer_player_id:e.customer_player_id??null,
   seller_id:e.player_id??null,customer_id:e.customer_player_id??null,craftsman_id:e.player_id??null,
   initiator_id:e.player_id??null,guild_id:p?.guild?.id??null,collector_id:e.collector_id??null,
   item_effects:e.item_effects??[],exotic_id:e.exotic_id??null,position:e.position??null,
   challenge_id:e.challenge_id??null,house_id:e.house_id??null,spell_id:e.spell_id??null,spell_grade_id:e.spell_grade_id??null,
   no_unic_count:e.no_unic_count??0,unic_count:e.unic_count??0,time_after_player_selection:e.time_after_player_selection??null,
   source_mode:MODE,local_test:true
  };
 });
}
