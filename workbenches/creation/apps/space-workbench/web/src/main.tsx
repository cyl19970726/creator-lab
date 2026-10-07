import React from 'react';
import {createRoot} from 'react-dom/client';
import {SpaceWorkbench} from '@signal-room/workflow-workbench-ui';
import '@signal-room/workflow-workbench-ui/style.css';
import './host.css';

const segment=window.location.pathname.slice('/space-workbench/'.length).split('/')[0];
const spaceId=decodeURIComponent(segment||'creator-content');
const root=document.getElementById('root');
if(!root)throw new Error('Space workbench mount is missing.');
createRoot(root).render(<React.StrictMode><SpaceWorkbench spaceId={spaceId} basePath="/space-workbench" /></React.StrictMode>);
