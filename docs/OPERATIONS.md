# BetLedger: operación segura del motor probabilístico

## Estado y límites del producto

BetLedger es una herramienta privada de apoyo a decisiones. No garantiza beneficios, no realiza apuestas, no propone stake y no reemplaza la revisión humana. Una probabilidad bien calibrada puede perder en cualquier partido; el objetivo del sistema es medir incertidumbre y valor esperado, no prometer aciertos.

El pipeline actual entrena sólo con resultados históricos disponibles antes de cada corte. Incluye un baseline Poisson, Dixon–Coles + Elo como modelo principal promovible y un gradient boosting 1X2 independiente en `shadow`. Lesiones, sanciones, objetivos deportivos, descanso, alineaciones y noticias se almacenan por separado; sus coeficientes permanecen en cero hasta que exista evidencia fuera de muestra suficiente. Esta separación evita presentar ajustes heurísticos como si fueran causales.

El alcance inicial es 1X2 y Over/Under 2.5. BTTS, marcadores y clasificación UEFA son informativos. No hay apuestas en vivo, combinadas, hándicap asiático ni automatización de apuestas.

## Paso cero: rotar todo lo expuesto

Antes de desplegar, completa estas acciones en los paneles oficiales. No reutilices ningún valor que haya aparecido en un chat, commit, captura o log.

1. Revoca el Personal Access Token de Supabase compartido anteriormente y crea uno nuevo sólo si el CLI lo necesita.
2. Restablece la contraseña propuesta para el propietario mediante una invitación o recuperación de Supabase Auth. No la establezcas en SQL, código ni GitHub Actions.
3. Rota las credenciales de cualquier casa de apuestas que estuvieran incrustadas en versiones anteriores del repositorio.
4. Revisa el historial Git y los logs de CI. Si un secreto llegó a un commit, trátalo como comprometido incluso después de borrar la línea.
5. Conserva `service_role` exclusivamente en Supabase Secrets y GitHub Actions Secrets. El navegador sólo puede recibir la URL del proyecto y la clave pública anon/publishable.

La rotación ocurre fuera del repositorio. Ninguna migración puede revocar un PAT, cambiar una contraseña externa o invalidar credenciales de terceros.

## Preparación de Supabase

### 1. Respaldo verificable

Haz un backup antes de aplicar migraciones. Verifica que contenga las tablas del ledger, sus 101 apuestas actuales, el perfil y los dos bankrolls. Conserva el backup fuera del repositorio y registra su fecha y checksum. No vuelvas a ejecutar `supabase/002_manual_schema.sql`: es un archivo histórico destructivo.

Con un proyecto enlazado y credenciales nuevas, revisa primero el plan:

```powershell
npx supabase link --project-ref $env:SUPABASE_PROJECT_REF
npx supabase db push --dry-run
```

Después del backup y de revisar el diff, aplica exclusivamente las migraciones incrementales de `supabase/migrations/`:

```powershell
npx supabase db push
```

No marques una migración como aplicada sólo para omitir un error sin entender su causa.

### 2. Único usuario propietario

En Authentication:

1. Desactiva el registro público.
2. Crea exactamente un usuario por invitación al correo del propietario.
3. Completa el establecimiento de contraseña usando el enlace seguro.
4. Copia el UUID del usuario, no su contraseña.

La migración nunca autoasigna datos, aunque sólo exista un usuario. Después de comprobar el correo exacto, ejecuta desde un contexto administrativo de confianza:

```sql
select public.configure_app_owner('<OWNER_USER_UUID>'::uuid, '<OWNER_EMAIL>');
```

Confirma que existe un solo propietario y que todos los datos heredados quedaron asignados:

```sql
select user_id, role from public.app_members;
select count(*) as bets, count(owner_id) as owned_bets from public.manual_bets;
select count(*) as profiles, count(owner_id) as owned_profiles from public.bankroll_profiles;
select count(*) as channels, count(owner_id) as owned_channels from public.channel_bankrolls;
```

Los conteos totales y con `owner_id` deben coincidir. Si no coinciden, detén el despliegue; no intentes “arreglar” el saldo manualmente.

La asignación crea checkpoints inmutables del saldo inicial y actual para cada perfil y canal. Conserva las 101 apuestas históricas sin inventar eventos por apuesta y permite reconciliar todos los movimientos nuevos desde un punto de apertura auditable.
La misma transacción valida los límites de stake y convierte `owner_id` en obligatorio; si queda una fila huérfana o inválida, todo el bootstrap se revierte y debe investigarse antes de reintentar.

### 3. Prueba de RLS

Verifica con una sesión anónima que las consultas a datos privados no devuelven filas y las mutaciones fallan. Verifica luego con el usuario propietario que sólo puede acceder a sus filas. Finalmente inspecciona el bundle generado y confirma que no contiene `service_role`, PATs, claves de proveedores ni contraseñas.

## Configuración local del frontend

Usa `.env.local`, que está ignorado por Git. Sólo contiene valores públicos:

```dotenv
VITE_SUPABASE_URL=https://PROJECT_REF.supabase.co
VITE_SUPABASE_ANON_KEY=PUBLIC_ANON_OR_PUBLISHABLE_KEY
VITE_OWNER_EMAIL=owner@example.com
```

Instala y verifica:

```powershell
npm ci
npm run check
```

No uses `VITE_` para ningún secreto: Vite incorpora esas variables al bundle del navegador.

## Secrets de Edge Functions

Configura los siguientes valores mediante Supabase Dashboard o un mecanismo que no los deje en el historial del shell:

- `API_FOOTBALL_KEY`: clave del proveedor API-Football.
- `FOOTBALL_DATA_API_KEY`: clave de football-data.org.
- `BETLEDGER_AUTOMATION_SECRET`: valor aleatorio de alta entropía para trabajos programados.
- `API_FOOTBALL_DAILY_CAP=70`: techo interno; la variable puede reducirlo, pero la base y la función impiden elevarlo por encima de 70.
- `FOOTBALL_DATA_DAILY_CAP=100`: techo conservador para el proveedor de calendario/tablas.
- `ALLOWED_ORIGINS`: orígenes exactos del frontend, separados por comas.
- `CONTEXT_SOURCE_HOSTS`: allowlist opcional, separada por comas, de fuentes HTTPS adicionales.

`SUPABASE_URL`, `SUPABASE_ANON_KEY` y `SUPABASE_SERVICE_ROLE_KEY` son secretos reservados/disponibles en el entorno de Edge Functions. La implementación usa `service_role` sólo dentro de la función y valida al propietario o el secreto de automatización antes de ejecutar.

Cada respuesta de proveedor conserva payload, hash, HTTP status, hora y `data_state`. Una respuesta vacía de API-Football se marca `empty_unverified`: se puede reutilizar temporalmente desde caché para proteger la cuota, pero nunca se interpreta como “sin bajas” ni habilita una recomendación. Agotar cuota cambia el último dato a `stale`; el detalle sigue mostrando la última información y bloquea el registro hasta una actualización completa.

Despliega las funciones autenticadas después de las migraciones:

```powershell
npx supabase functions deploy refresh-fixture
npx supabase functions deploy sync-football
npx supabase functions deploy extract-context
npx supabase functions deploy review-context
npx supabase functions deploy register-recommendation
```

`sync-football` y `refresh-fixture` aceptan automatización únicamente mediante el secreto dedicado; las demás llamadas requieren la sesión del propietario. No expongas un endpoint administrativo sin esa validación.

## GitHub Actions

Crea un GitHub Environment llamado `production`, restringido a la rama protegida desde la que se ejecutarán los jobs. Guarda allí, como secrets y nunca como variables públicas:

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY` (sólo para el job de entrenamiento)
- `BETLEDGER_OWNER_ID`
- `BETLEDGER_AUTOMATION_SECRET`
- `BETLEDGER_SEALED_SEASON`, por ejemplo la última temporada completa validada

`SUPABASE_PROJECT_REF` puede existir como variable local para enlazar el CLI, pero los workflows no la usan. Las claves de datos deportivos deben residir en Supabase Secrets; el job de sincronización llama a Edge Functions y no necesita conocerlas. El job de sincronización tampoco recibe permisos de `GITHUB_TOKEN`. Limita quién puede editar workflows y revisa que los jobs no impriman el entorno. Si el environment exige aprobación manual, recuerda que también detendrá cada ejecución programada; para estos jobs conviene usar restricciones de rama y revisión de cambios al workflow.

Cadencias esperadas:

- sincronización central cada tres horas;
- revisión de ventanas próximas cada 30 minutos, consultando sólo fixtures que lo requieran;
- entrenamiento diario a las 04:00 de Guayaquil (09:00 UTC), que se salta si el fingerprint de resultados no cambió;
- ejecución manual por fecha, competición o fixture.

Las inferencias de `T-24h`, `T-6h` y XI oficial son snapshots inmutables. Un hash canónico versionado cubre fixture, historial, modelo, reglas, contexto, escenarios de alineación y cuotas; si un reintento recibe exactamente las mismas entradas, devuelve `inputs_unchanged` y no duplica snapshots ni recomendaciones. Un cambio material dentro del mismo horizonte sí genera un corte nuevo y auditable.

El workflow de CI se ejecuta en `push`, `pull_request` y manualmente sin recibir secretos. Verifica lint, pruebas unitarias, bundle de producción, los tres self-tests Python, el type-check Deno y una reconstrucción local de las migraciones seguida de pgTAP para RLS, inmutabilidad e idempotencia. Las acciones de terceros están fijadas a commits inmutables; actualízalas deliberadamente mediante un PR, después de revisar la versión. El workflow de entrenamiento distingue ejecuciones `scheduled` y `manual`; si no hay resultados nuevos termina correctamente sin intentar subir un artifact inexistente. Cada artifact nuevo usa también el número de intento para que una reejecución no colisione con un artifact inmutable previo.

## Pipeline de entrenamiento

### Instalación aislada

Usa Python 3.9 o superior. Las versiones de NumPy/SciPy están fijadas para que entrenamiento e inferencia dorada sean reproducibles.

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install --upgrade pip
python -m pip install -r pipeline\requirements.txt
python pipeline\train_model.py --self-test
python pipeline\gradient_boosting.py
python pipeline\backfill_history.py --self-test
```

El self-test verifica distribución normalizada, evaluación walk-forward sin cruce temporal y el caso dorado del Excel: con λ local 1.9814 y λ visitante 1.2299, Over 2.5 es aproximadamente 62.24%.

### Ejecución de producción

El job lee estas variables sin mostrarlas:

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `BETLEDGER_OWNER_ID` (opcional si existe exactamente un propietario)
- `BETLEDGER_SEALED_SEASON` (obligatoria para que una promoción sea elegible)
- `MIN_TRAINING_MATCHES` (por defecto 100)
- `MIN_EVALUATION_FIXTURES` (por defecto 100)
- `BOOTSTRAP_SAMPLES` (por defecto 2000)
- `TRAINING_TRIGGER_TYPE`: `scheduled`, `manual` o `backfill`
- `FORCE_RETRAIN`, `COMPETITION_CODE` y `PROMOTE_IF_ELIGIBLE` para ejecuciones manuales controladas.

```powershell
python pipeline\train_model.py --output-dir pipeline\artifacts
```

El flujo es:

1. Lee fixtures `finished` con resultados no nulos y su primer `result_available_at`.
2. Calcula un SHA-256 determinista sobre IDs, marcadores, disponibilidad del resultado y `updated_at`.
3. Si el fingerprint coincide con la última ejecución exitosa/omitida, registra `skipped` y termina.
4. Ordena temporadas por competición y entrena cada fold sólo con temporadas cuyo último partido es anterior al primer partido del fold de prueba. Dentro de cada fold, un resultado sólo actualiza Elo o features desde `result_available_at`; si el origen histórico no ofrece ese timestamp se usa `kickoff + 3h`, evitando que un encuentro de las 14:00 filtre su marcador a otro de las 15:00.
5. Evalúa 1X2 con log loss, Brier y error de calibración, además de bootstrap pareado.
6. Ajusta modelos finales con todos los resultados disponibles hasta el corte.
7. Escribe atómicamente un JSON versionado y guarda Dixon–Coles + Elo como `shadow`.
8. Guarda también el gradient boosting como modelo `shadow` separado. No puede promoverse todavía porque sólo produce 1X2 y no satisface el contrato de una distribución única para goles y mercados.
9. Sólo si Dixon–Coles + Elo pasa todas las puertas llama a `promote_model_version`, que vuelve a validar métricas y cambia el campeón dentro de una transacción.

El artifact publica `inference_contract_version=football-probability-v1`, parámetros por competición y fallbacks globales (`rho`, ventaja local, Elo y ratings por UUID de equipo). También publica `uncertainty_method=poisson_exposure_qmc_v1` y una desviación estándar logarítmica acotada por competición. La inferencia mezcla 81 perturbaciones cuasi Monte Carlo deterministas, centradas en media uno, para construir el intervalo predictivo del 90%. Esa escala es una aproximación conservadora basada en exposición Poisson, no un intervalo causal ni una garantía de calibración; un artifact sin ese contrato sólo puede producir resultados informativos.

`context_enabled=false` y `context_coefficients={}` permanecen bloqueados hasta validar una familia contextual. Las pruebas doradas entre Python y TypeScript deben comparar el mismo artifact antes de desplegar una versión de inferencia. El hash de identidad incluye la versión del motor, y la generación enlaza el snapshot anterior: un reintento exacto se deduplica, mientras que una secuencia de estado `A → B → A` conserva las tres revisiones auditables.

Las puertas de promoción son conservadoras:

- mejora relativa de log loss de al menos 1%;
- límite inferior del intervalo bootstrap 95% mayor que cero;
- Brier y calibración no peores;
- degradación de log loss no superior a 2% por competición ni horizonte;
- al menos 100 fixtures en la temporada completa sellada;
- optimización correcta en todos los folds relevantes.

Sin `BETLEDGER_SEALED_SEASON`, sin datos suficientes o con una métrica ausente, `promotion_eligible` es falso. El modelo sigue en shadow y no habilita candidatos.

### Reproducción offline

Para depurar sin acceder a Supabase, suministra un JSON con una lista `fixtures`. Cada fila necesita `id`, `competition_id`, `competition_code`, `season`, `kickoff_at`, `home_team_id`, `away_team_id`, `home_score` y `away_score`:

```powershell
python pipeline\train_model.py --input-json .\private-fixtures.json --dry-run --output-dir .\tmp-artifacts
```

No subas datasets privados ni artifacts con identificadores internos al repositorio. Conserva cada artifact promovido y su SHA-256 en el almacenamiento protegido de CI para poder reproducir inferencia y rollback.

### Backfill histórico privado

`pipeline/backfill_history.py` convierte archivos locales sin descargarlos ni escribir en Supabase. Acepta CSV de Football-Data.co.uk y JSON de OpenFootball, rechaza marcadores incompletos, normaliza fechas/temporadas, elimina duplicados exactos y genera el contrato que consume `train_model.py --input-json`.

Para combinar cinco temporadas, descarga los archivos manualmente después de revisar sus términos y usa mapas explícitos de equipos/competiciones cuando deban coincidir con UUID productivos:

```powershell
python pipeline\backfill_history.py `
  --input .\private-history\E0_2021-22.csv `
  --input .\private-history\E0_2022-23.csv `
  --input .\private-history\E0_2023-24.csv `
  --input .\private-history\E0_2024-25.csv `
  --input .\private-history\E0_2025-26.csv `
  --format football-data `
  --source-timezone Europe/London `
  --team-map .\private-history\team-map.json `
  --competition-code PL `
  --strict `
  --output .\private-history\pl-training.json

python pipeline\train_model.py --input-json .\private-history\pl-training.json --dry-run
```

Los nombres sin mapa reciben IDs históricos deterministas y quedan enumerados en metadata; no deben confundirse con equipos productivos. No agregues archivos fuente, mapas privados ni salidas a Git.

## Operación de proveedores

Mantén `API_FOOTBALL_DAILY_CAP=70`, caché y backoff. La sincronización rutinaria de API-Football se limita a ayer–14 días; calendarios y tablas UEFA se cachean cinco horas, lesiones una hora, cuotas 20 minutos y estado individual 20 minutos. La cuota se prioriza para partidos cercanos y cada fixture permite como máximo dos solicitudes reales de alineación, sin retries ocultos. Una respuesta vacía no significa “sin bajas” y nunca elimina disponibilidades previas. Cuando la cuota se agota, conserva el último dato con estado `stale` y bloquea recomendaciones que requieran frescura.

Antes de cada temporada, revisa cobertura, límites, retención y términos directamente en los sitios de football-data.org, API-Football, Football-Data.co.uk y OpenFootball. Los planes gratuitos y las condiciones pueden cambiar. No muestres logos, no redistribuyas datasets y no comercialices la salida sin una revisión legal/licenciamiento nueva.

## Revisión de contexto

Las URLs introducidas deben ser HTTPS, pasar la allowlist/validación SSRF, respetar tamaño máximo y no seguir redirects. La extracción guarda una paráfrasis factual, hash y enlace; no copia el artículo.

Prioridad de evidencia:

1. fuente oficial;
2. proveedor estructurado;
3. prensa fiable;
4. comunidad;
5. rumor.

Noticias y declaraciones entran como `pending`. El propietario puede aprobar, corregir o rechazar. Prensa aprobada puede ampliar incertidumbre y bloquear una recomendación hasta confirmación oficial; rumores, redes sociales y picks de tipsters nunca cambian automáticamente probabilidades.

## Lista de activación

Mantén todas las recomendaciones desactivadas hasta cumplir, como mínimo:

- 30 días de shadow mode;
- 100 fixtures completados;
- cobertura de datos centrales de al menos 99%;
- cobertura de XI oficial de al menos 80% en cada competición habilitada;
- backtest walk-forward reproducible y gates de promoción aprobados;
- ninguna clave privilegiada en bundle, repositorio o logs;
- prueba anónima de lectura y mutación fallida;
- ledger reconciliado: saldo actual igual a eventos inmutables más ajustes autorizados.

Incluso con modelo campeón, un candidato en papel exige XI oficial, cuota de máximo 30 minutos, ausencia de conflictos materiales, EV conservador de al menos 2% y probabilidad de EV positivo de al menos 90%. Sólo puede existir uno por partido y registrarlo requiere confirmación manual.

La activación se realiza por competición y la propia base rechaza valores que no cumplan los mínimos. Desde un contexto `service_role`, y sólo después de calcular las coberturas auditables:

```sql
select public.set_competition_recommendation_activation(
  '<OWNER_UUID>'::uuid,
  '<COMPETITION_UUID>'::uuid,
  true,
  100,
  0.99,
  0.80,
  '{"evidence":"validated-shadow-report"}'::jsonb
);
```

El reloj de 30 días usa `shadow_started_at` guardado en la base; falsear los números no sustituye la validación.

## Monitoreo y respuesta a fallos

Revisa diariamente:

- consumo por proveedor y llamadas denegadas por cuota;
- datos `stale`, fixtures aplazados y alineaciones ausentes;
- ejecuciones `failed` o `skipped` en `training_runs` y `sync_runs`;
- calibración por competición/horizonte;
- duplicados rechazados por claves de idempotencia;
- reconciliación de `bankroll_events`, operaciones y saldo.

Ante un fallo de modelo, retira el challenger (estado `retired`) y conserva probabilidades base informativas. Ante un fallo de sincronización, no borres el último snapshot válido: márcalo stale y bloquea candidatos. Ante exposición de un secreto, revócalo primero, luego investiga alcance; borrar el texto no invalida la credencial.

## Validación previa a cada despliegue

```powershell
npm run check
python pipeline\train_model.py --self-test
npx deno check supabase/functions/sync-football/index.ts supabase/functions/refresh-fixture/index.ts supabase/functions/extract-context/index.ts supabase/functions/review-context/index.ts supabase/functions/register-recommendation/index.ts
npx supabase db push --dry-run
```

Después del despliegue, prueba login, recuperación, logout, RLS anónimo/propietario, actualización manual de un fixture, revisión de contexto y conversión idempotente de una recomendación en apuesta. No uses una apuesta real como prueba.
