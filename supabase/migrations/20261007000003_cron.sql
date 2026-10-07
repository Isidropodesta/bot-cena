create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.schedule(
  'chequeo-egrefest',
  '20 seconds',
  $job$
  select net.http_post(
    url := 'https://qslwxcosxxusoxckgpuw.supabase.co/functions/v1/chequeo',
    headers := jsonb_build_object(
      'content-type', 'application/json',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 10000
  );
  $job$
);
