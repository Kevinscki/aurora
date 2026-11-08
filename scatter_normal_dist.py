import numpy as np
import plotly.graph_objects as go

# Set random seed for reproducibility
np.random.seed(42)

# Parameters for Normal Distribution
mean = 0
std_dev = 1
num_points = 500

# Generate normally distributed data
data = np.random.normal(mean, std_dev, num_points)

# Create the plot using Plotly Express (faster for headless envs often)
fig = go.Figure()

# Add scatter trace
fig.add_trace(go.Scatter(x=data, y=data, mode='markers', 
                         marker=dict(size=6, color='blue', line=dict(width=0.5, color='black')),
                         name='Generated Data'))

# Set layout
fig.update_layout(
    title=f'Scatter Diagram: Normal Distribution\n(μ={mean}, σ={std_dev})',
    xaxis_title='X-Axis (Value)',
    yaxis_title='Y-Axis (Value)',
    hovermode='closest'
)

# Save the figure as a PNG file
output_file = 'scatter_normal_dist.png'
fig.write_image(output_file, engine="cairo")  # Use Cairo backend for better resolution in scripts
print(f"Scatter diagram saved to {output_file}")
