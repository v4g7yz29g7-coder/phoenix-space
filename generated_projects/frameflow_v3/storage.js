// /home/ishidin/phoenix/public/js/projectStorage.js

const PROJECTS_KEY = 'phoenix_projects';

function saveProject(photos, layout, settings) {
    const projects = getAllProjects();
    const project = {
        id: Date.now().toString(36) + Math.random().toString(36).substr(2, 5),
        photos: photos || [],
        layout: layout || {},
        settings: settings || {},
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
    };
    
    projects.push(project);
    localStorage.setItem(PROJECTS_KEY, JSON.stringify(projects));
    
    return getAllProjects();
}

function getAllProjects() {
    try {
        const data = localStorage.getItem(PROJECTS_KEY);
        return data ? JSON.parse(data) : [];
    } catch (error) {
        console.error('Error reading projects from localStorage:', error);
        return [];
    }
}

function getProjectById(id) {
    const projects = getAllProjects();
    return projects.find(project => project.id === id) || null;
}

function updateProject(id, updates) {
    const projects = getAllProjects();
    const index = projects.findIndex(project => project.id === id);
    
    if (index !== -1) {
        projects[index] = {
            ...projects[index],
            ...updates,
            updatedAt: new Date().toISOString()
        };
        localStorage.setItem(PROJECTS_KEY, JSON.stringify(projects));
    }
    
    return getAllProjects();
}

function deleteProject(id) {
    const projects = getAllProjects();
    const filteredProjects = projects.filter(project => project.id !== id);
    localStorage.setItem(PROJECTS_KEY, JSON.stringify(filteredProjects));
    
    return getAllProjects();
}

function clearAllProjects() {
    localStorage.removeItem(PROJECTS_KEY);
    return [];
}

// Export for browser and Node.js environments
if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        saveProject,
        getAllProjects,
        getProjectById,
        updateProject,
        deleteProject,
        clearAllProjects
    };
} else {
    window.ProjectStorage = {
        saveProject,
        getAllProjects,
        getProjectById,
        updateProject,
        deleteProject,
        clearAllProjects
    };
}
