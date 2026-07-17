// Skrzynki zespołowe: jeden adres dla wielu kont, z własną nazwą nadawcy
// i prawem wysyłki per członek. Zespół nie ma magazynu: przy fan-oucie każda
// wiadomość jest czyjąś kopią, więc miejsce, foldery i kosz zostają przy koncie.
//
// Moduł jest liściem, jak quota.js i aliases.js: nie importuje mail.js, więc
// nie ma cyklu. Adresy skleja wołający przez addressOf, tak samo jak przy aliasach.

import { now } from './db.js';

export function findTeam(db, localPart) {
  return db.prepare('SELECT id, local_part, name FROM teams WHERE local_part = ?').get(localPart) ?? null;
}

export function teamById(db, id) {
  return db.prepare('SELECT id, local_part, name, created_at FROM teams WHERE id = ?').get(id) ?? null;
}

// Skrzynki, do których rozejdzie się kopia. Blokady nie filtrujemy: poczta na
// adres wprost też ją ignoruje (findMailbox), a zespół z samych zablokowanych
// zacząłby odbijać pocztę. Wypisanie takiego konta należy do administratora.
export function teamMailboxes(db, teamId) {
  return db
    .prepare(
      `SELECT u.id, u.login, u.name FROM team_members m
       JOIN users u ON u.id = m.user_id
       WHERE m.team_id = ? ORDER BY u.login`
    )
    .all(teamId);
}

export function teamMembers(db, teamId) {
  return db
    .prepare(
      `SELECT u.id AS user_id, u.login, u.name, m.can_send FROM team_members m
       JOIN users u ON u.id = m.user_id
       WHERE m.team_id = ? ORDER BY u.login`
    )
    .all(teamId)
    .map((m) => ({ ...m, can_send: !!m.can_send }));
}

export function userTeams(db, userId) {
  return db
    .prepare(
      `SELECT t.id, t.local_part, t.name, m.can_send FROM team_members m
       JOIN teams t ON t.id = m.team_id
       WHERE m.user_id = ? ORDER BY t.local_part`
    )
    .all(userId)
    .map((t) => ({ ...t, can_send: !!t.can_send }));
}

// Zespół, z którego to konto wolno nadawać. null znaczy: nie wolno.
export function canSendAs(db, userId, localPart) {
  return (
    db
      .prepare(
        `SELECT t.id, t.local_part, t.name FROM teams t
         JOIN team_members m ON m.team_id = t.id
         WHERE t.local_part = ? AND m.user_id = ? AND m.can_send = 1`
      )
      .get(localPart, userId) ?? null
  );
}

export function listTeams(db) {
  return db
    .prepare('SELECT id, local_part, name, created_at FROM teams ORDER BY local_part')
    .all()
    .map((t) => ({ ...t, members: teamMembers(db, t.id) }));
}

export function createTeam(db, { localPart, name }) {
  const id = Number(
    db
      .prepare('INSERT INTO teams (local_part, name, created_at) VALUES (?, ?, ?)')
      .run(localPart, name, now()).lastInsertRowid
  );
  return teamById(db, id);
}

// Adres zespołu jest niezmienny: to tożsamość wobec wszystkich, którzy go znają.
export function renameTeam(db, id, name) {
  return db.prepare('UPDATE teams SET name = ? WHERE id = ?').run(name, id).changes > 0;
}

export function deleteTeam(db, id) {
  return db.prepare('DELETE FROM teams WHERE id = ?').run(id).changes > 0;
}

// Dopisuje członka albo zmienia jego prawo wysyłki; idempotentne dzięki
// PRIMARY KEY (team_id, user_id).
export function setMember(db, teamId, userId, canSend) {
  db.prepare(
    `INSERT INTO team_members (team_id, user_id, can_send, created_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(team_id, user_id) DO UPDATE SET can_send = excluded.can_send`
  ).run(teamId, userId, canSend ? 1 : 0, now());
}

export function removeMember(db, teamId, userId) {
  return db.prepare('DELETE FROM team_members WHERE team_id = ? AND user_id = ?').run(teamId, userId).changes > 0;
}
