import { createComponent } from 'tinybubble'
import './style.css'
import { startSession } from './rpc/session.js'
import { router } from './router.js'

startSession()
createComponent({ name: 'TravelMoreRouter', components: { 'router-view': router.RouterView }, template: () => '<div class="app-shell"><router-view></router-view></div>' }).appendTo(document.getElementById('app'))
