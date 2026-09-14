# BetLedger

Aplicación privada de registro de apuestas y análisis probabilístico prepartido de fútbol. El motor publica 1X2 y Over/Under 2.5; BTTS, marcadores y clasificación UEFA son informativos. No coloca apuestas, no recomienda stake y puede concluir legítimamente `no apostar`.

## Componentes

- React 19 + TypeScript + Vite para login, ledger, predicciones y revisión humana.
- Supabase Auth/Postgres/RLS y RPC transaccionales e idempotentes.
- Edge Functions para sincronización, cuotas, XI, bajas y extracción segura de contexto.
- Baseline Poisson, modelo principal Dixon–Coles + Elo, intervalos QMC de 81 escenarios y gradient boosting separado en shadow mode.
- GitHub Actions para sincronizar cada 3 horas, revisar ventanas cada 30 minutos y entrenar a las 04:00 de Guayaquil.
- CI sin secretos para lint, pruebas, build, contrato Python y type-check de Edge Functions.

## Desarrollo

```powershell
Copy-Item .env.example .env.local
npm ci
npm run check
python pipeline\train_model.py --self-test
python pipeline\gradient_boosting.py
python pipeline\backfill_history.py --self-test
npx deno check supabase/functions/sync-football/index.ts supabase/functions/refresh-fixture/index.ts supabase/functions/extract-context/index.ts supabase/functions/review-context/index.ts supabase/functions/register-recommendation/index.ts
```

Configura sólo la URL y clave pública de Supabase en `.env.local`. Nunca pongas `service_role`, PATs, claves deportivas ni contraseñas en variables `VITE_*`.

## Despliegue

No ejecutes los SQL históricos `supabase/002_manual_schema.sql` ni `supabase/003_channel_bankrolls.sql`. Aplica únicamente `supabase/migrations/` después de crear un backup y revisar `npx supabase db push --dry-run`.

Antes de desplegar debes revocar todos los secretos que hayan aparecido en chat o historial, desactivar registro público, invitar al único propietario y asignarlo explícitamente mediante la RPC administrativa documentada. Las recomendaciones permanecen bloqueadas por competición hasta superar 30 días, 100 fixtures y los umbrales de cobertura.

La guía completa, importación histórica offline, secretos requeridos, pruebas RLS, funciones y runbook están en [docs/OPERATIONS.md](docs/OPERATIONS.md).

## Aviso

Las probabilidades son estimaciones y no garantizan beneficio. Este proyecto está diseñado para uso privado y modo papel inicial. Revisa licencias y condiciones de cada proveedor antes de publicar, mostrar logos, redistribuir datos o comercializar resultados.
