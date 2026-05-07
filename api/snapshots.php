<?php
declare(strict_types=1);

require __DIR__ . '/_bootstrap.php';

$user = require_user();
$userId = (int) $user['id'];

function snapshot_to_payload(array $row): array
{
    $positions = $row['positions_json'] ? (json_decode($row['positions_json'], true) ?: []) : [];
    return [
        'id' => (int) $row['id'],
        'date' => (string) $row['snapshot_date'],
        'title' => date('M j, Y', strtotime((string) $row['snapshot_date'])),
        'portfolio' => [
            'value' => (float) $row['portfolio_value'],
            'cost' => (float) $row['portfolio_cost'],
            'dayPnl' => (float) $row['day_pnl'],
            'dayPct' => (float) $row['day_pct'],
            'gain' => (float) $row['total_gain'],
            'gainPct' => (float) $row['total_gain_pct'],
        ],
        'positions' => $positions,
        'tasks' => [
            'open' => (int) $row['open_tasks'],
            'due' => (int) $row['due_tasks'],
        ],
        'report' => (string) ($row['report'] ?? ''),
        'source' => (string) ($row['source'] ?? 'cron'),
        'createdAt' => $row['created_at'],
    ];
}

if ($_SERVER['REQUEST_METHOD'] === 'GET') {
    $limit = max(1, min(365, (int) ($_GET['limit'] ?? 90)));
    $stmt = db()->prepare('SELECT * FROM snapshots WHERE user_id = ? ORDER BY snapshot_date DESC LIMIT ' . $limit);
    $stmt->execute([$userId]);
    $rows = $stmt->fetchAll();
    respond(['ok' => true, 'snapshots' => array_map('snapshot_to_payload', $rows)]);
}

if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    require_csrf();
    $body = read_json();
    $action = (string) ($body['action'] ?? '');

    if ($action === 'capture') {
        // Manual capture from the History page. Server still computes from the
        // request payload — saves a round-trip and lets users snapshot at any
        // moment they choose.
        $date = (string) ($body['date'] ?? date('Y-m-d'));
        if (!preg_match('/^\d{4}-\d{2}-\d{2}$/', $date)) {
            respond(['ok' => false, 'error' => 'date must be YYYY-MM-DD'], 400);
        }
        $portfolio = $body['portfolio'] ?? [];
        $positions = $body['positions'] ?? [];
        $tasks = $body['tasks'] ?? [];
        $report = (string) ($body['report'] ?? '');

        $stmt = db()->prepare(
            'INSERT INTO snapshots
              (user_id, snapshot_date, portfolio_value, portfolio_cost, day_pnl, day_pct, total_gain, total_gain_pct, open_tasks, due_tasks, positions_json, report, source)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, "manual")
             ON DUPLICATE KEY UPDATE
              portfolio_value = VALUES(portfolio_value),
              portfolio_cost  = VALUES(portfolio_cost),
              day_pnl         = VALUES(day_pnl),
              day_pct         = VALUES(day_pct),
              total_gain      = VALUES(total_gain),
              total_gain_pct  = VALUES(total_gain_pct),
              open_tasks      = VALUES(open_tasks),
              due_tasks       = VALUES(due_tasks),
              positions_json  = VALUES(positions_json),
              report          = VALUES(report),
              source          = "manual"'
        );
        $stmt->execute([
            $userId, $date,
            (float) ($portfolio['value'] ?? 0),
            (float) ($portfolio['cost'] ?? 0),
            (float) ($portfolio['dayPnl'] ?? 0),
            (float) ($portfolio['dayPct'] ?? 0),
            (float) ($portfolio['gain'] ?? 0),
            (float) ($portfolio['gainPct'] ?? 0),
            (int) ($tasks['open'] ?? 0),
            (int) ($tasks['due'] ?? 0),
            json_encode($positions, JSON_UNESCAPED_SLASHES),
            $report,
        ]);
        respond(['ok' => true]);
    }

    if ($action === 'delete') {
        $id = (int) ($body['id'] ?? 0);
        if ($id <= 0) respond(['ok' => false, 'error' => 'id required'], 400);
        $stmt = db()->prepare('DELETE FROM snapshots WHERE id = ? AND user_id = ?');
        $stmt->execute([$id, $userId]);
        respond(['ok' => true]);
    }

    respond(['ok' => false, 'error' => 'Unsupported snapshot action.'], 400);
}

respond(['ok' => false, 'error' => 'Unsupported method.'], 405);
