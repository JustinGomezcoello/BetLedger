import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';

const resources = {
    en: {
        translation: {
            "app": {
                "edition": "MANUAL EDITION",
                "dashboard": "Overview",
                "newBet": "New Bet",
                "history": "Bet History",
                "settings": "Settings",
                "openMenu": "Open Menu"
            },
            "dashboard": {
                "title": "Overview",
                "subtitle": "Track your manual ledger performance in real-time.",
                "live": "Live Connection",
                "currentBankroll": "Current Bankroll",
                "historical": "All Time",
                "roi": "Return on Investment (ROI)",
                "roiSubtitle": "Based on initial",
                "winRate": "Win Rate",
                "won": "Won",
                "lost": "Lost",
                "pendingBets": "Pending Bets",
                "awaitingResolution": "Awaiting manual resolution",
                "evolution": "Bankroll Evolution",
                "resolveOne": "Resolve at least one bet to start seeing your bankroll evolution chart.",
                "recentActivity": "Recent Activity",
                "noBets": "No bets recorded yet. Create one!",
                "stake": "Stake",
                "start": "Start"
            },
            "betsList": {
                "title": "Betting History",
                "subtitle": "Manage and resolve your manual entries.",
                "date": "Date",
                "category": "Category",
                "selection": "Selection",
                "description": "Description",
                "odds": "Odds",
                "stake": "Stake",
                "result": "Result",
                "actions": "Actions",
                "units": "Units",
                "won": "Won",
                "lost": "Lost",
                "pending": "Pending",
                "winBtn": "Win",
                "lossBtn": "Loss",
                "delBtn": "Delete Bet",
                "noHistory": "No bets found in your ledger. Head over to New Bet to add your first entry!",
                "confirmWin": "Are you sure you want to resolve this bet as WON?",
                "confirmLoss": "Are you sure you want to resolve this bet as LOST?",
                "confirmDel": "Delete this pending bet completely?",
                "errResolve": "Failed to resolve bet.",
                "errDel": "You can only delete pending bets to avoid messing up the bankroll history.",
                "loading": "Loading History..."
            },
            "newBet": {
                "title": "New Bet",
                "subtitle": "Manually register a new bet in your ledger.",
                "success": "Bet registered successfully! Pending result.",
                "date": "Bet Date",
                "category": "Category / Football, Tennis, etc.",
                "catPlaceholder": "Football, Tennis, NFL...",
                "type": "Bet Type",
                "single": "Single",
                "double": "Double",
                "parlay": "Parlay/Acca",
                "stake": "Stake (1 to 10)",
                "selection": "Selection (Teams/Match)",
                "selPlaceholder": "e.g. Real Madrid vs Barcelona",
                "description": "Description (Pick rationale)",
                "descPlaceholder": "e.g. Real Madrid to Win and Over 2.5 Total Goals",
                "odds": "Odds",
                "registerBtn": "Register Bet",
                "saving": "Saving..."
            },
            "settings": {
                "title": "Platform Settings",
                "subtitle": "Manage your bankroll variables and risk management.",
                "loading": "Loading Settings...",
                "success": "Bankroll profile updated successfully.",
                "error": "Error updating settings.",
                "configTitle": "Bankroll Configuration",
                "configSub": "Set up how much capital you are risking.",
                "startBank": "Starting Bankroll ($)",
                "startDesc": "Your initial deposit used to calculate your All-Time ROI.",
                "currentBank": "Current Bankroll ($)",
                "currentDesc": "Updates automatically as you win/lose, but you can override it here if you inject/withdraw capital.",
                "stakeLimit": "Max Stake Percentage limit (Stake 10/10)",
                "stake1": "1% of Bankroll",
                "stake2": "2.5% of Bankroll",
                "stake5": "5% of Bankroll (Recommended)",
                "stake10": "10% of Bankroll (High Risk)",
                "stake25": "25% of Bankroll (Degenerate)",
                "stakeDesc": "Defines the $ amount of a 'Stake 10' bet relative to your bankroll.",
                "compounding": "Enable Compounding Rule",
                "compDesc": "If active, your stake amount scales up or down based on your 'Current' bankroll. If off, it uses 'Starting' bankroll only.",
                "saveBtn": "Save Configuration",
                "saving": "Saving..."
            }
        }
    },
    es: {
        translation: {
            "app": {
                "edition": "EDICIÓN MANUAL",
                "dashboard": "Panel General",
                "newBet": "Nueva Apuesta",
                "history": "Historial de Apuestas",
                "settings": "Configuración",
                "openMenu": "Abrir menú"
            },
            "dashboard": {
                "title": "Visión General",
                "subtitle": "Controla el rendimiento de tu ledger manual en tiempo real.",
                "live": "Conexión en Vivo",
                "currentBankroll": "Banco Actual",
                "historical": "Histórico",
                "roi": "Retorno de Inversión (ROI)",
                "roiSubtitle": "Sobre los",
                "winRate": "Win Rate (Acierto)",
                "won": "Ganadas",
                "lost": "Perdidas",
                "pendingBets": "Apuestas Pendientes",
                "awaitingResolution": "Esperando resolución manual",
                "evolution": "Evolución del Banco",
                "resolveOne": "Resuelve al menos una apuesta para empezar a ver el gráfico de evolución de tu banco.",
                "recentActivity": "Actividad Reciente",
                "noBets": "Aún no hay apuestas registradas. ¡Crea la primera!",
                "stake": "Stake",
                "start": "Inicio"
            },
            "betsList": {
                "title": "Historial de Apuestas",
                "subtitle": "Gestiona y resuelve tus entradas manuales.",
                "date": "Fecha",
                "category": "Categoría",
                "selection": "Selección",
                "description": "Descripción",
                "odds": "Cuota",
                "stake": "Stake",
                "result": "Resultado",
                "actions": "Acciones",
                "units": "Unidades",
                "won": "Ganada",
                "lost": "Perdida",
                "pending": "Pendiente",
                "winBtn": "Ganar",
                "lossBtn": "Perder",
                "delBtn": "Eliminar Apuesta",
                "noHistory": "No hay apuestas en tu historial. ¡Ve a Nueva Apuesta para registrar la primera!",
                "confirmWin": "¿Estás seguro de que quieres resolver esta apuesta como GANADA?",
                "confirmLoss": "¿Estás seguro de que quieres resolver esta apuesta como PERDIDA?",
                "confirmDel": "¿Eliminar esta apuesta pendiente por completo?",
                "errResolve": "Error al resolver la apuesta.",
                "errDel": "Solo puedes eliminar apuestas pendientes para evitar descuadrar el historial de tu banco.",
                "loading": "Cargando Historial..."
            },
            "newBet": {
                "title": "Nueva Apuesta",
                "subtitle": "Registra una nueva apuesta en tu ledger manualmente.",
                "success": "¡Apuesta registrada exitosamente! Ahora está pendiente de resultado.",
                "date": "Fecha de Apuesta",
                "category": "Categoría / Fútbol, Tenis, etc.",
                "catPlaceholder": "Fútbol, Tenis, NFL...",
                "type": "Tipo de Apuesta",
                "single": "Sencilla (Single)",
                "double": "Doble (Double)",
                "parlay": "Combinada (Parlay/Acca)",
                "stake": "Stake (del 1 al 10)",
                "selection": "Selección (Equipos/Partido)",
                "selPlaceholder": "Ej. Real Madrid vs Barcelona",
                "description": "Descripción (Logística del Pick)",
                "descPlaceholder": "Ej. Real Madrid Gana y Más de 2.5 Goles",
                "odds": "Cuota (Odds)",
                "registerBtn": "Registrar Apuesta",
                "saving": "Guardando..."
            },
            "settings": {
                "title": "Configuración",
                "subtitle": "Gestiona las variables de tu banco y gestión de riesgo.",
                "loading": "Cargando Configuración...",
                "success": "Perfil de banco actualizado exitosamente.",
                "error": "Error al actualizar configuración.",
                "configTitle": "Configuración del Banco (Bankroll)",
                "configSub": "Configura cuánto capital estás arriesgando.",
                "startBank": "Banco Inicial ($)",
                "startDesc": "Tu depósito inicial usado para calcular tu ROI histórico.",
                "currentBank": "Banco Actual ($)",
                "currentDesc": "Se actualiza automáticamente cuando ganas/pierdes, pero puedes sobrescribirlo si inyectas/retiras capital.",
                "stakeLimit": "Límite Porcentual de Stake (Stake 10/10)",
                "stake1": "1% del Banco",
                "stake2": "2.5% del Banco",
                "stake5": "5% del Banco (Recomendado)",
                "stake10": "10% del Banco (Alto Riesgo)",
                "stake25": "25% del Banco (Degenerado)",
                "stakeDesc": "Define la cantidad en $ de una apuesta 'Stake 10' relativa a tu banco.",
                "compounding": "Activar Regla de Interés Compuesto",
                "compDesc": "Si está activa, tu monto de stake escala basándose en tu banco 'Actual'. Si está inactiva, usa sólo tu banco 'Inicial' para siempre mantener un riesgo plano.",
                "saveBtn": "Guardar Configuración",
                "saving": "Guardando..."
            }
        }
    }
};

i18n
    .use(initReactI18next)
    .init({
        resources,
        lng: "es",
        fallbackLng: "en",
        interpolation: {
            escapeValue: false
        }
    });

export default i18n;
