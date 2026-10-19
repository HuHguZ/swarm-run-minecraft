'use strict'
// Единственное место, где импортируются файлы этапов: порядок импортов — порядок вызовов defStage, то есть порядок STAGES
// (поведение; stages/table assertStageOrder проверяет его при запуске).
import './overworld'
import './route'
import './nether'
import './end'
