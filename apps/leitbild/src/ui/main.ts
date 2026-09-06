import { mount } from 'svelte'
import App from './App.svelte'
import Wiki from './Wiki.svelte'
import './styles.css'

const target = document.querySelector('#app')
if (!(target instanceof HTMLElement)) throw new Error('Workspace Host UI root is missing')

if (location.pathname === '/wiki') mount(Wiki, { target })
else mount(App, { target })
