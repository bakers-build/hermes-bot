<?php

/**
 * @file
 * Seeds a fresh bakers.build 0.11.0 site for the PM bot's end-to-end test (tests/e2e/run.sh).
 *
 * Run: drush php:script /path/to/seed.php
 *
 * Idempotent: workspace, team, group, project, users, memberships, machine
 * and conductor are looked up by stable names and reused. API key secrets are
 * only readable at creation, so every run revokes the previous seed keys (by
 * label) and issues fresh ones; the JSON on stdout always carries working
 * keys.
 *
 * Environment (all optional):
 *   SEED_MACHINE_ID   host_key of the seeded bb_machine; give the CLI's
 *                     machine.config.js the same machine_id to adopt the
 *                     seeded conductor. Default below.
 *   SEED_KEY_DAYS     API key lifetime in days (1..365). Default 30.
 *
 * Prints exactly one JSON object on stdout; diagnostics go to stderr.
 */

use Drupal\bb_api_key\ServiceAccountManager;
use Drupal\bb_core\Entity\BbWorkspace;
use Drupal\bb_core\Members\MemberItemBuilder;
use Drupal\og\Og;
use Drupal\og\OgMembershipInterface;

const SEED_PROJECT_NAME = 'E2E Project';
const SEED_PROJECT_KEY = 'E2E';
const SEED_WORKFLOW = 'bb_work';
const SEED_TEAM_NAME = 'E2E Team';
const SEED_GROUP_NAME = 'E2E Group';
const SEED_BOT_STEM = 'hermes-bot';
const SEED_OWNER_NAME = 'e2e-owner';
const SEED_OWNER_MAIL = 'owner@example.test';
const SEED_REQUESTER_NAME = 'e2e-requester';
const SEED_REQUESTER_MAIL = 'requester@example.test';
const SEED_KEY_LABEL = 'hermes-e2e-seed';
const SEED_MACHINE_NAME = 'e2e-machine';
const SEED_CONDUCTOR_ID = 'e2e-seeded-conductor';
const SEED_DEFAULT_MACHINE_ID = 'e2e0c0de-0000-4000-8000-000000000001';
const SEED_MIN_CLIENT_VERSION = '0.11.0';

$etm = \Drupal::entityTypeManager();
$log = static fn (string $m) => fwrite(STDERR, "[seed] $m\n");
$first = static fn (array $r) => $r ? reset($r) : NULL;

// Everything below runs as uid 1 (instance admin): entity validation checks
// reference access against the current user.
$admin = $etm->getStorage('user')->load(1);
$switcher = \Drupal::service('account_switcher');
$switcher->switchTo($admin);

try {
  // 6. min_client_version: CLI 0.11.0 must not be refused on claim routes.
  $settings = \Drupal::configFactory()->getEditable('bb_core.settings');
  $min = (string) $settings->get('min_client_version');
  if ($min === '' || version_compare($min, SEED_MIN_CLIENT_VERSION, '>')) {
    $settings->set('min_client_version', SEED_MIN_CLIENT_VERSION)->save();
    $log("min_client_version $min -> " . SEED_MIN_CLIENT_VERSION);
  }

  // A `site:install --existing-config` site builds its router before og's
  // membership bundle exists, so JSON:API has no og_membership--default
  // routes and GET /jsonapi/ (which `bakers init --online` and the conductor
  // read) fails with 500 "Route jsonapi.og_membership--default.collection
  // does not exist". Rebuild the router once when that route is missing.
  if (!\Drupal::service('router.route_provider')->getRoutesByNames(['jsonapi.og_membership--default.collection'])) {
    \Drupal::service('router.builder')->rebuild();
    $log('rebuilt router (missing JSON:API og_membership routes)');
  }

  // 1a. Workspace: the default one bb_core_install() creates.
  $workspace = $first($etm->getStorage('bb_workspace')->loadByProperties(['uuid' => BbWorkspace::DEFAULT_UUID]));
  if (!$workspace) {
    throw new \RuntimeException('Default workspace missing; is bakers.build installed?');
  }

  // Human users.
  $userStorage = $etm->getStorage('user');
  $human = static function (string $name, string $mail) use ($userStorage, $first, $log) {
    $user = $first($userStorage->loadByProperties(['name' => $name]))
      ?: $first($userStorage->loadByProperties(['mail' => $mail]));
    if (!$user) {
      $user = $userStorage->create([
        'name' => $name,
        'mail' => $mail,
        'init' => $mail,
        'pass' => bin2hex(random_bytes(16)),
        'status' => 1,
      ]);
      $user->save();
      $log("created user $name");
    }
    return $user;
  };
  $owner = $human(SEED_OWNER_NAME, SEED_OWNER_MAIL);
  $requester = $human(SEED_REQUESTER_NAME, SEED_REQUESTER_MAIL);

  // 1b. Team and group in that workspace.
  $team = $first($etm->getStorage('bb_team')->loadByProperties(['name' => SEED_TEAM_NAME, 'workspace_id' => $workspace->id()]));
  if (!$team) {
    $team = $etm->getStorage('bb_team')->create([
      'name' => SEED_TEAM_NAME,
      'workspace_id' => $workspace->id(),
      'owner_user_id' => $owner->id(),
    ]);
    $team->save();
    $log('created team');
  }
  $group = $first($etm->getStorage('bb_group')->loadByProperties(['name' => SEED_GROUP_NAME, 'workspace_id' => $workspace->id()]));
  if (!$group) {
    $group = $etm->getStorage('bb_group')->create([
      'name' => SEED_GROUP_NAME,
      'workspace_id' => $workspace->id(),
      'owner_user_id' => $owner->id(),
    ]);
    $group->save();
    $log('created group');
  }

  // Memberships: ensure an active membership carrying exactly one standard
  // role (or none = the implicit Member rank).
  $writer = \Drupal::service('bb_core.membership_writer');
  $member = static function ($group, $user, ?string $role) use ($writer) {
    $membership = Og::getMembership($group, $user, OgMembershipInterface::ALL_STATES);
    if (!$membership) {
      $writer->add($group, $user->id());
      $membership = Og::getMembership($group, $user, OgMembershipInterface::ALL_STATES);
    }
    if ($membership->getState() !== OgMembershipInterface::STATE_ACTIVE) {
      $membership->setState(OgMembershipInterface::STATE_ACTIVE)->save();
    }
    $roles = MemberItemBuilder::assignableRoles($group);
    if ($role !== NULL && !isset($roles[$role])) {
      throw new \RuntimeException("Role $role is not assignable on " . $group->getEntityTypeId());
    }
    if ($role !== NULL && !$membership->hasRole($roles[$role]->id())) {
      $membership->setRoles([$roles[$role]])->save();
    }
  };
  // 3. Owner: workspace Admin (lead) + team lead.
  $member($workspace, $owner, 'lead');
  $member($team, $owner, 'lead');
  // 4. Requester: workspace contributor + team member.
  $member($workspace, $requester, 'contributor');
  $member($team, $requester, NULL);

  // 1c. Project, key E2E, owned by the conductor owner.
  $projectStorage = $etm->getStorage('bb_project');
  $project = $first($projectStorage->loadByProperties(['key' => SEED_PROJECT_KEY]));
  if (!$project) {
    $project = $projectStorage->create([
      'name' => SEED_PROJECT_NAME,
      'key' => SEED_PROJECT_KEY,
      'group_id' => $group->id(),
      'teams' => [$team->id()],
      'owner_user_id' => $owner->id(),
    ]);
    $violations = $project->validate();
    if (count($violations)) {
      $msgs = [];
      foreach ($violations as $v) {
        $msgs[] = $v->getPropertyPath() . ': ' . $v->getMessage();
      }
      throw new \RuntimeException('Project invalid: ' . implode('; ', $msgs));
    }
    $project->save();
    $log('created project');
  }
  // Billing: every project needs a resolvable default account.
  \Drupal::service('bb_track.assignments')->createDefaultAccount($project);

  // 2. Bot: a workspace service account (contributor + team member).
  $sam = \Drupal::service('bb_api_key.service_account_manager');
  $akm = \Drupal::service('bb_api_key.manager');
  $expiryDays = max(1, min(365, (int) (getenv('SEED_KEY_DAYS') ?: 30)));
  $expiryDate = gmdate('Y-m-d', \Drupal::time()->getCurrentTime() + $expiryDays * 86400);
  $botIds = $userStorage->getQuery()->accessCheck(FALSE)
    ->condition('name', 'service-' . SEED_BOT_STEM . '-', 'STARTS_WITH')
    ->condition(ServiceAccountManager::MARKER_FIELD, $workspace->id())
    ->condition('status', 1)
    ->sort('uid')
    ->execute();
  $bot = $botIds ? $userStorage->load(reset($botIds)) : NULL;
  $revokeSeedKeys = static function ($user) use ($etm, $akm) {
    $storage = $etm->getStorage('consumer');
    $ids = $storage->getQuery()->accessCheck(FALSE)
      ->condition('owner_id', $user->id())
      ->condition('label', SEED_KEY_LABEL)
      ->execute();
    foreach ($storage->loadMultiple($ids) as $consumer) {
      if ($akm->isManaged($consumer)) {
        $consumer->delete();
      }
    }
  };
  if (!$bot) {
    $created = $sam->create($workspace, $team, SEED_BOT_STEM, 'contributor', 'member', $expiryDate, $admin, SEED_KEY_LABEL);
    $bot = $created['user'];
    $botKey = $created['consumer']->get('client_id')->value . ':' . $created['secret'];
    $log('created service account ' . $bot->getAccountName());
  }
  else {
    $member($workspace, $bot, 'contributor');
    $member($team, $bot, NULL);
    $revokeSeedKeys($bot);
    $issued = $sam->issueKey($bot, $expiryDate, $admin, SEED_KEY_LABEL);
    $botKey = $issued['consumer']->get('client_id')->value . ':' . $issued['secret'];
  }

  // 3b. Owner personal API key (created as the owner, as the UI does).
  $revokeSeedKeys($owner);
  $switcher->switchTo($owner);
  try {
    $issued = $akm->create($owner, SEED_KEY_LABEL, $akm->expiryTimestamp($expiryDate));
  }
  finally {
    $switcher->switchBack();
  }
  $ownerClientId = $issued['consumer']->get('client_id')->value;
  $ownerSecret = $issued['secret'];

  // 5. Machine + conductor owned by the owner, adoptable by `bakers` whose
  // machine_id equals SEED_MACHINE_ID: the CLI registers conductor_id
  // "<machine_id>-E2E Project-conductor", which is unknown, so the server
  // offers this conductor (same owner + project + machine + default variant)
  // and `bakers conductor start --adopt <uuid>` takes it over.
  $machineId = getenv('SEED_MACHINE_ID') ?: SEED_DEFAULT_MACHINE_ID;
  $machine = $first($etm->getStorage('bb_machine')->loadByProperties(['host_key' => $machineId]));
  if (!$machine) {
    $machine = $etm->getStorage('bb_machine')->create([
      'name' => SEED_MACHINE_NAME,
      'host_key' => $machineId,
      'owner_user_id' => $owner->id(),
      'assignment' => 'allow',
    ]);
    $machine->save();
    $log('created machine');
  }
  $conductorStorage = $etm->getStorage('bb_conductor');
  // After an adoption the record keeps its uuid but takes the CLI's id, so
  // look it up by owner + project + machine first.
  $conductor = $first($conductorStorage->loadByProperties([
    'owner_user_id' => $owner->id(),
    'project_id' => $project->id(),
    'machine' => $machine->id(),
  ])) ?: $first($conductorStorage->loadByProperties(['conductor_id' => SEED_CONDUCTOR_ID]));
  if (!$conductor) {
    $conductor = $conductorStorage->create([
      'conductor_id' => SEED_CONDUCTOR_ID,
      'label' => SEED_MACHINE_NAME . ' · ' . SEED_PROJECT_NAME,
      'owner_user_id' => $owner->id(),
      'active' => TRUE,
      'status' => 'offline',
      'project_id' => $project->id(),
      'machine' => $machine->id(),
      'assignment' => 'machine',
    ]);
    $violations = $conductor->validate();
    if (count($violations)) {
      $msgs = [];
      foreach ($violations as $v) {
        $msgs[] = $v->getPropertyPath() . ': ' . $v->getMessage();
      }
      throw new \RuntimeException('Conductor invalid: ' . implode('; ', $msgs));
    }
    $conductor->save();
    $log('created conductor');
  }
  // Working runs only: the server takes a conductor's states when it creates the record, and a
  // stub agent has nothing to do in qualification or review.
  if ($conductor->get('states')->getValue() !== [['value' => 'working']]) {
    $conductor->set('states', ['working'])->save();
  }

  $out = [
    'workspace_uuid' => $workspace->uuid(),
    'team_uuid' => $team->uuid(),
    'group_uuid' => $group->uuid(),
    'project_uuid' => $project->uuid(),
    'project_key' => $project->get('key')->value,
    'project_name' => $project->label(),
    'workflow' => SEED_WORKFLOW,
    'bot_user_uuid' => $bot->uuid(),
    'bot_user_name' => $bot->getAccountName(),
    'bot_api_key' => $botKey,
    'owner_user_uuid' => $owner->uuid(),
    'owner_user_name' => $owner->getAccountName(),
    'owner_email' => $owner->getEmail(),
    'owner_client_id' => $ownerClientId,
    'owner_client_secret' => $ownerSecret,
    'owner_api_key' => $ownerClientId . ':' . $ownerSecret,
    'requester_user_uuid' => $requester->uuid(),
    'requester_user_name' => $requester->getAccountName(),
    'requester_email' => $requester->getEmail(),
    'conductor_uuid' => $conductor->uuid(),
    'conductor_id' => $conductor->get('conductor_id')->value,
    'machine_id' => $machineId,
    'min_client_version' => (string) \Drupal::config('bb_core.settings')->get('min_client_version'),
    'key_expires' => $expiryDate,
  ];
  fwrite(STDOUT, json_encode($out, JSON_UNESCAPED_SLASHES | JSON_PRETTY_PRINT) . "\n");
}
finally {
  $switcher->switchBack();
}
