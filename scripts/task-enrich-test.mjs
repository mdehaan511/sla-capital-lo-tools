/**
 * scripts/task-enrich-test.mjs — Deploy 236.931
 *
 * Gate for _shared/task-enrich.mjs: tasks leave tasks-list carrying the
 * loan's address and people's names, never bare ids / emails.
 *
 * Run: node scripts/task-enrich-test.mjs
 */
import { prettyNameFromEmail, profileName, applyEnrichment } from '../deploy/netlify/functions/_shared/task-enrich.mjs';

let failures = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log((ok ? '  ok   ' : '  FAIL ') + name +
    (ok ? '' : '\n         expected ' + JSON.stringify(expected) + '\n         got      ' + JSON.stringify(actual)));
}

console.log('task enrich gate\n');

check('carl.davis@ → Carl Davis', prettyNameFromEmail('carl.davis@slacapital.com'), 'Carl Davis');
check('sara.s@ → Sara S', prettyNameFromEmail('Sara.S@slacapital.com'), 'Sara S');
check('mike@ → Mike', prettyNameFromEmail('mike@slacapital.com'), 'Mike');
check('marianne.wentzel@ → Marianne Wentzel', prettyNameFromEmail('marianne.wentzel@slacapital.com'), 'Marianne Wentzel');
check('system@ → SLA Platform', prettyNameFromEmail('system@slacapital.com'), 'SLA Platform');
check('blank → blank', prettyNameFromEmail(''), '');

check('profile fullName', profileName({ fullName: 'Carl Major Davis III' }), 'Carl Major Davis III');
check('profile user_metadata.full_name', profileName({ user_metadata: { full_name: 'Elle Julian' } }), 'Elle Julian');
check('profile first + last', profileName({ firstName: 'Jessy', lastName: 'Ortiz' }), 'Jessy Ortiz');
check('no profile → blank', profileName(null), '');

{
  const tasks = [
    { id: 't1', loanId: 'L1', assignedTo: 'carl.davis@slacapital.com', createdBy: 'system@slacapital.com', createdByName: 'SLA Platform (auto-task)' },
    { id: 't2', loanId: 'L2', assignedTo: 'jessy@slacapital.com', assignedToName: 'Jessy (picked)', createdBy: 'mike@slacapital.com' },
    { id: 't3', loanId: 'L_missing', assignedTo: '' },
  ];
  applyEnrichment(tasks, { L1: '2524 Hawthorne Ave, Evansville, IN', L2: '634 E Walnut Pl' }, { 'carl.davis@slacapital.com': 'Carl Major Davis III' });
  check('address from the loan', tasks[0].address, '2524 Hawthorne Ave, Evansville, IN');
  check('assignee name from the profile', tasks[0].assignedToName, 'Carl Major Davis III');
  check('an existing (picked) name is kept', tasks[1].assignedToName, 'Jessy (picked)');
  check('creator name falls back to the email when no profile', tasks[1].createdByName, 'Mike');
  check('a stored creator name is kept', tasks[0].createdByName, 'SLA Platform (auto-task)');
  check('unknown loan → empty address, not undefined', tasks[2].address, '');
  check('no assignee → empty name', tasks[2].assignedToName, '');
  check('other fields untouched', [tasks[0].id, tasks[0].loanId, tasks[0].assignedTo], ['t1', 'L1', 'carl.davis@slacapital.com']);
  check('null-safe', applyEnrichment(null), null);
}

console.log('\n' + (failures ? failures + ' CHECK(S) FAILED' : 'all checks pass'));
process.exit(failures ? 1 : 0);
