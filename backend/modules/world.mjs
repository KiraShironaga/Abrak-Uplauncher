import{seedCommon}from'./world-common.mjs';
import*as content from'./world-content.mjs';
import*as catalog from'./world-catalog.mjs';
import*as progress from'./world-progress.mjs';
import*as events from'./world-events.mjs';
import*as admin from'./world-admin.mjs';
const modules=[content,catalog,progress,events,admin];
export function seed(state){if(state.meta('worldSeededV1',false)){content.migrate(state);return;}state.transaction(()=>{seedCommon(state);for(const m of modules)m.seed?.(state);content.migrate(state);state.setMeta('worldSeededV1',true);});}
export function register(router){for(const m of modules)m.register(router);}
export const acceptanceCases=[
{name:'public-content',method:'GET',path:'/api/pages/news/0',expectStatus:200},
{name:'calendar-array',method:'GET',path:'/api/calendar/events',expectStatus:200},
{name:'catalog-drop-options',method:'GET',path:'/api/pages/encyclopedia/5/drop',expectStatus:200},
{name:'catalog-alteres-rows',method:'GET',path:'/api/pages/encyclopedia/5/alteres',expectStatus:200},
{name:'ranking-experience',method:'GET',path:'/api/pages/rankings/5/experience',expectStatus:200},
{name:'battlepass-unauthorized',method:'GET',path:'/api/battlepass',expectStatus:401},
{name:'battlepass-shape',method:'GET',path:'/api/battlepass',auth:'player',expectStatus:200},
{name:'stats-overview',method:'POST',path:'/api/pages/user/stats/index',auth:'player',body:{filters:{},size:10},expectStatus:200},
{name:'admin-denied',method:'GET',path:'/api/admin/beta-access',auth:'player',expectStatus:403},
{name:'admin-context',method:'GET',path:'/api/admin/process-detections/users/2/context',auth:'admin',expectStatus:200},
{name:'unknown-command-rejected',method:'POST',path:'/api/admin/login/destructive-unknown',auth:'admin',body:{},expectStatus:422},
{name:'unknown-stat-rejected',method:'POST',path:'/api/pages/user/stats/unsupported',auth:'player',body:{},expectStatus:404},
{name:'cross-owner-event-denied',method:'POST',path:'/api/local/world/events',auth:'player',body:{type:'fight',player_id:1,quantity:1},expectStatus:403},
{name:'vote-state',method:'GET',path:'/api/pages/user/vote',auth:'player',expectStatus:200},
{name:'local-draft',method:'GET',path:'/api/draft/local-test',auth:'player',expectStatus:200},
{name:'suggestions-array',method:'GET',path:'/api/suggestions',expectStatus:200},
{name:'bugs-array-envelope',method:'GET',path:'/api/public/dev-bugs?list_type=bug',expectStatus:200}
];
